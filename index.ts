import { MarketCache, PoolCache } from './cache';
import { GrpcListeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, SERUM_PROGRAM_ID_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
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
} from './helpers';  
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import Client from "@triton-one/yellowstone-grpc";
import { log } from 'console';

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
    filters: [
      {
        // Filtering by base mint address
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('baseMint'), // Adjust based on whether it's the base or quote token
          bytes: mintPubKey.toBase58(),
        },
      },
      // You can add another filter for the quote mint if needed
    ],
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

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
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

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig); 

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }
 
  const listeners = new GrpcListeners(client, connection);
  await listeners.start({
    walletPublicKey: accountPubKey,
    quoteToken,
    autoSell: AUTO_SELL, 
  }); 

  const poolState = await fetchLiquidityStateByMintAddress(connection, TOKEN_ACCOUNT);
  const market = await fetchMarketStateByMintAddress(connection, TOKEN_ACCOUNT);
  const rawAccounts = await fetchRawAccountsByMintAddress(connection, TOKEN_ACCOUNT);
  logger.trace(`RawAccounts: ${JSON.stringify(rawAccounts)}`); 
  logger.trace({ token: TOKEN_ACCOUNT }, `Fetching pool and market state`); 
  //logger.trace(`Found Raw Accounts: ${JSON.stringify(rawAccounts)}`);

  listeners.on(`new_swap`, async(chunk: any) => {  
    const tx = await connection.getParsedTransaction(chunk.signature, { maxSupportedTransactionVersion: 0});
    if (!tx) {
      logger.error(`Transaction not found: ${chunk.signature}`);
      return;
    } else { 
      // Get pre/post balances and account keys
      const preBalances = tx.meta?.preTokenBalances;
      const postBalances = tx.meta?.postTokenBalances;
      const accountKeys = tx.transaction.message.accountKeys;

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
        const preWsolAmount = wsolPreBalance.uiTokenAmount.uiAmount;
        const postWsolAmount = wsolPostBalance.uiTokenAmount.uiAmount;

        const preTokenAAmount = tokenAPreBalance.uiTokenAmount.uiAmount;
        const postTokenAAmount = tokenAPostBalance.uiTokenAmount.uiAmount;

        // Buy (SOL -> TokenA) if WSOL decreases and TokenA increases
        if (postWsolAmount! > preWsolAmount! && postTokenAAmount! < preTokenAAmount!) {
          logger.trace(`Detected a Buy transaction: \n${chunk.signature}`); 

          //await bot.sell(chunk.accountId, accountData);
        } 
      } else {
        logger.error(`Could not find matching WSOL or TokenA accounts in the transaction.`);
      }
    }
  }); 

  printDetails(wallet, quoteToken, bot);
};

runListener();
