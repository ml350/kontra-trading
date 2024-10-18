import { MarketCache, PoolCache } from './cache';
import { GrpcListeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
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
  CACHE_NEW_MARKETS,  
  SELL_SLIPPAGE, 
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  TOKEN_ACCOUNT,
  GRPC_ENDPOINT,
  GRPC_TOKEN, 
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
    walletPublicKey: new PublicKey(TOKEN_ACCOUNT),
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS
  }); 

  listeners.on(`new_buy`, async(updatedAccountInfo: KeyedAccountInfo) => { 
    logger.trace(`New buy detected: ${updatedAccountInfo.accountId.toString()}`);
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    await bot.sell(updatedAccountInfo.accountId, accountData);
  });

  printDetails(wallet, quoteToken, bot);
};

runListener();
