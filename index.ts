import { MarketCache, PoolCache } from './cache';
import { GrpcListeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, Market, MARKET_STATE_LAYOUT_V3, SERUM_PROGRAM_ID_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL, 
  QUOTE_MINT, 
  QUOTE_AMOUNT,
  PRIVATE_KEY, 
  ONE_TOKEN_AT_A_TIME,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL, 
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE, 
  SELL_SLIPPAGE, 
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  TOKEN_ACCOUNT,
  GRPC_ENDPOINT,
  GRPC_TOKEN,
  MINIMAL_MARKET_STATE_LAYOUT_V3,
  getMinimalMarketV3, 
} from './helpers';  
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import Client from "@triton-one/yellowstone-grpc"; 

const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN,
  {
    "grpc.max_receive_message_length": 1024 * 1024 * 2048,
  } 
) 
const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

function printDetails(wallet: Keypair, quoteToken: Token, bot: Bot) { 

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);
 

  logger.info('Bot is running! Press CTRL + C to stop it.');
}

async function fetchRawAccountsByMintAddress(
  connection: Connection,
  mintAddress: string
) {
  const mintPubKey = new PublicKey(mintAddress);

  // Fetch all token accounts associated with the mint address
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      {
        dataSize: 165,
      },
      {
        // Filter by mint address
        memcmp: {
          offset: 32, // The mint address is at offset 0 in the token account layout
          bytes: mintPubKey.toBase58(),
        },
      },
    ],
  });

  // Deserialize each account to get the RawAccount (Token Account Data)
  const rawAccounts = accounts.map((account) => {
    const accountInfo = AccountLayout.decode(account.account.data);
    return {
      pubkey: account.pubkey.toBase58(),
      accountInfo,
    };
  });

  return rawAccounts;
}

async function fetchLiquidityStateByMintAddress(
  connection: Connection,
  mintAddress: string
) {
  const mintPubKey = new PublicKey(mintAddress);

  // Fetching all program accounts for Raydium's liquidity program
  const accounts = await connection.getProgramAccounts(MAINNET_PROGRAM_ID.AmmV4, {
    filters: [
      {
        // Filtering by the mint address (either base or quote token in the pool)
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'), // Adjust based on your token's role in the pool (base/quote)
          bytes: mintPubKey.toBase58(),
        },
      },
    ],
  });

  // Deserializing each account data to get LiquidityStateV4
  const liquidityStates = accounts.map((account) => {
    return LIQUIDITY_STATE_LAYOUT_V4.decode(account.account.data);
  });

  return liquidityStates;
}

async function fetchMarketStateByMintAddress(
  connection: Connection,
  mintAddress: string
) {
  const mintPubKey = new PublicKey(mintAddress);

  // Fetch all program accounts for Serum's DEX program (V3 in this case)
  const accounts = await connection.getProgramAccounts(MAINNET_PROGRAM_ID.OPENBOOK_MARKET, {
    commitment: connection.commitment,
      dataSlice: {
        offset: MARKET_STATE_LAYOUT_V3.offsetOf('eventQueue'),
        length: MINIMAL_MARKET_STATE_LAYOUT_V3.span,
      },
      filters: [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: mintPubKey.toBase58(),
          },
        },
      ]
  });

  // Deserialize each account data to get MARKET_STATE_LAYOUT_V3
  const marketStates = accounts.map((account) => {
    return MARKET_STATE_LAYOUT_V3.decode(account.account.data);
  });

  return marketStates;
}

const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');
 
  const accountPubKey = new PublicKey(TOKEN_ACCOUNT);
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) { 
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),   
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME, 
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,  
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,  
    sellSlippage: SELL_SLIPPAGE, 
  };

  const bot = new Bot(connection, txExecutor, botConfig);  
 
  const listeners = new GrpcListeners(client, connection);
  await listeners.start({
    walletPublicKey: accountPubKey,
    quoteToken,
    autoSell: AUTO_SELL, 
  }); 

  const poolState = await fetchLiquidityStateByMintAddress(connection, TOKEN_ACCOUNT); 
  const minimal = await getMinimalMarketV3(connection, poolState[0].marketId, connection.commitment);
  logger.trace({ token: TOKEN_ACCOUNT }, `Fetching pool and market state`); 
  logger.trace(`Pool State: ${JSON.stringify(minimal)}`);

  listeners.on(`new_swap`, async(chunk: any) => {  
    const tx = await connection.getParsedTransaction(chunk.signature, { maxSupportedTransactionVersion: 0});
    if (!tx) {
      logger.error(`Transaction not found: ${chunk.signature}`);
      return;
    } else { 
      const jupiterProgramId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"; // Jupiter Aggregator Program ID
      let isJupiter = false;
      // Get pre/post balances and account keys
      const preBalances = tx.meta?.preTokenBalances;
      const postBalances = tx.meta?.postTokenBalances;
      const accountKeys = tx.transaction.message.accountKeys;

      // **Check if Jupiter is in the transaction's account keys** 
      if (!accountKeys.some(account => account.pubkey.toBase58() === jupiterProgramId)) { 
        logger.trace(`New Swap detected: \n${chunk.signature}`);
        return;
      } else { 
        logger.trace(`Jupiter Swap detected: ${chunk.signature}`);
        isJupiter = true;
      }

      // Ensure we have valid balances to compare
      if (!preBalances || !postBalances || !accountKeys) {
        logger.error(`Missing token balance or account key information`);
        return;
      }

      // Find WSOL and TokenA accounts using their mint addresses
      const wsolMint = "So11111111111111111111111111111111111111112"; // WSOL mint
      const tokenAMint = TOKEN_ACCOUNT; // Replace with actual TokenA mint

      const wsolPreBalance = preBalances.find(balance => balance.mint === wsolMint);
      const tokenAPreBalance = preBalances.find(balance => balance.mint === tokenAMint);

      const wsolPostBalance = postBalances.find(balance => balance.mint === wsolMint);
      const tokenAPostBalance = postBalances.find(balance => balance.mint === tokenAMint);

      if (wsolPreBalance && tokenAPreBalance && wsolPostBalance && tokenAPostBalance) {
        const preWsolAmount = wsolPreBalance.uiTokenAmount.uiAmount || 0;
        const postWsolAmount = wsolPostBalance.uiTokenAmount.uiAmount || 0;

        let preTokenAAmount = tokenAPreBalance?.uiTokenAmount.uiAmount || 0;
        const postTokenAAmount = tokenAPostBalance.uiTokenAmount.uiAmount || 0;
        

        if(isJupiter) { 
          
          logger.trace(`Detected a transaction: \n${preWsolAmount} \n${postWsolAmount} \n${preTokenAAmount} \n${postTokenAAmount}`); 
          // **Buy (WSOL -> TokenA) if WSOL decreases and TokenA increases**
          if (postTokenAAmount > preTokenAAmount) {  
            await bot.sell(chunk.accountId, TOKEN_ACCOUNT, poolState[0], minimal);
            return;
          } 
        }
        // Buy (SOL -> TokenA) if WSOL decreases and TokenA increases
        if (postWsolAmount! > preWsolAmount! && postTokenAAmount! < preTokenAAmount!) { 
          await bot.sell(chunk.accountId, TOKEN_ACCOUNT, poolState[0], minimal);
        } 
      } else {
        logger.error(`Could not find matching WSOL or TokenA accounts in the transaction.`);
      }
    }
  }); 

  printDetails(wallet, quoteToken, bot);
};

runListener();
