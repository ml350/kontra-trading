import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { ApiPoolInfoV4, Liquidity, LIQUIDITY_STATE_LAYOUT_V4, LiquidityPoolKeysV4, LiquidityStateV4, Market, MARKET_STATE_LAYOUT_V3, MarketStateLayoutV3, Percent, SPL_MINT_LAYOUT, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache } from './cache'; 
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, MinimalMarketLayoutV3, NETWORK, sleep } from './helpers';
import { Mutex } from 'async-mutex';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number; 
  buySlippage: number;
  sellSlippage: number; 
}

export class Bot {   
  // one token at the time 
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection, 
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isJito = txExecutor instanceof JitoTransactionExecutor; 
  } 

  public async sell(accountId: PublicKey, mint: string, state: LiquidityStateV4, market: MinimalMarketLayoutV3) {
    const mintP = new PublicKey(mint);
    try {
      logger.trace({ mint: mintP }, `Processing new token...`);
      const tokenAta = await getAssociatedTokenAddress(new PublicKey(mint), this.config.wallet.publicKey)
      const tokenBalInfo = await this.connection.getTokenAccountBalance(tokenAta)
      const tokenBalance = tokenBalInfo.value.amount
      const poolData = state;

      if (!poolData) {
        logger.trace({ mint: mintP.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.baseMint, poolData.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, tokenBalance, true);
      if (tokenAmountIn.isZero()) {
        logger.warn({ mint: mintP.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: mintP }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }
  
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(mintP, poolData, market); 

      logger.trace({ mint: mintP.toString(), balance: tokenAmountIn.toFixed() }, `Token Info`);
      logger.trace({ mint: mintP.toString() }, `Pool Keys: ${JSON.stringify(poolKeys)} \n: Market: ${JSON.stringify(market)}`);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: mintP },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );
 
          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          ); 

          if (result.confirmed) {
            logger.trace(
              {
                dex: `https://dexscreener.com/solana/${mintP.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: mintP.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          // logger.info(
          //   {
          //     mint: mintP.toString(),
          //     signature: result.signature,
          //     error: result.error,
          //   },
          //   `Error confirming sell tx`,
          // );
        } catch (error) {
          logger.debug({ mint:mintP.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: mintP.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    console.log(`Pool Keys before fetchInfo`, JSON.stringify(poolKeys));
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });
    
    
    console.log('works2');

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });
    
    console.log('works3');
 

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }
   
}
