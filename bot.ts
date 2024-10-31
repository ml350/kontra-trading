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
import { ApiPoolInfoV4, jsonInfo2PoolKeys, Liquidity, LIQUIDITY_STATE_LAYOUT_V4, LiquidityPoolKeys, LiquidityPoolKeysV4, LiquidityStateV4, Market, MARKET_STATE_LAYOUT_V3, MarketStateLayoutV3, Percent, SPL_MINT_LAYOUT, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { PoolKeys } from './utils/getPoolKeys';
import { TransactionExecutor } from './transactions';
import { AVG_SELL_AMOUNT, createPoolKeys, HIGH_SELL_AMOUNT, logger, LOW_SELL_AMOUNT, MinimalMarketLayoutV3, NETWORK, sleep,  } from './helpers'; 
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import BN from 'bn.js';

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

  public async sell(accountId: PublicKey, mint: string, poolState: LiquidityPoolKeysV4, amount: number) {
    const mintP = new PublicKey(mint);
    try { 
      logger.trace({ mint: mintP }, `Processing new token...`);
      const tokenAta = await getAssociatedTokenAddress(mintP, this.config.wallet.publicKey)
      const tokenBal = await this.connection.getTokenAccountBalance(tokenAta)

      if (!tokenBal || tokenBal.value.uiAmount == 0)
        return null

      const balance = tokenBal.value.amount
      tokenBal.value.decimals
      const baseToken = new Token(TOKEN_PROGRAM_ID, mintP, tokenBal.value.decimals);
      // Use amount as UI amount and set isRaw to false
      const baseTokenAmount = new TokenAmount(baseToken, amount, false);

      const sellPercentages = [AVG_SELL_AMOUNT, HIGH_SELL_AMOUNT, LOW_SELL_AMOUNT];
      const selectedSellPercentage = sellPercentages[Math.floor(Math.random() * sellPercentages.length)];
      const chunkPercentage = new BN(selectedSellPercentage);

      // Calculate chunkAmount in raw units
      const chunkAmount = baseTokenAmount.raw.mul(chunkPercentage).div(new BN(100));
      const chunkAmountIn = new TokenAmount(baseToken, chunkAmount, true); 
      const poolData = poolState;
    
      if (!poolData) {
        logger.trace({ mint: mintP.toString() }, `Token pool data is not found, can't sell`);
        return;
      } 
      if (baseTokenAmount.isZero()) {
        logger.warn({ mint: mintP.toString() }, `Empty balance, can't sell`);
        return;
      }  

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: mintP },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );
 
          const result = await this.swap(
            poolState,
            tokenAta,
            this.config.quoteAta,
            baseToken,
            this.config.quoteToken,
            chunkAmountIn,
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
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });
  
    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    }); 
 
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
        ...(direction === 'sell' ? [] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }
   
}
