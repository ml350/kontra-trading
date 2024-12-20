import { MarketCache, PoolCache } from './cache';
import { GrpcListeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { Liquidity, LIQUIDITY_STATE_LAYOUT_V4, LiquidityPoolKeysV4, MAINNET_PROGRAM_ID, Market, MARKET_STATE_LAYOUT_V3, SERUM_PROGRAM_ID_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
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
  MINIMUM_BUY_TRIGGER, 
  SOL_DIST,
  THRESHOLD_SOL,
  DIST_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} from './helpers';  
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import Client from "@triton-one/yellowstone-grpc"; 
import bs58 from 'bs58';
import { PoolKeys } from './utils/getPoolKeys';
import { SystemProgram, Transaction } from '@solana/web3.js';

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';

const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN,
  {
    "grpc.max_receive_message_length": 1024 * 1024 * 2048,
  } 
) 

const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
// Define wsolMintPubKey
const wsolMintPubKey = new PublicKey('So11111111111111111111111111111111111111112'); // WSOL mint

// Function to load blacklisted wallets from blacklist.txt
function loadBlacklist() {
  const filePath = path.join(__dirname, 'blacklist.txt');
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return new Set(data.split('\n').map(line => line.trim()).filter(Boolean));
  } catch (error) {
    logger.error('Failed to load blacklist:', error);
    return new Set();
  }
}

function loadWallets(): PublicKey[] {
  const filePath = path.join(__dirname, 'wallets.txt');
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const walletAddresses = data.split('\n').map(line => line.trim()).filter(Boolean);
    return walletAddresses.map(address => new PublicKey(address));
  } catch (error) {
    logger.error('Failed to load wallets:', error);
    return [];
  }
}

async function distributeSol(wallet: Keypair): Promise<void> {
  const wallets = loadWallets();
  if (wallets.length === 0) {
    logger.error('No wallets to distribute SOL to.');
    return;
  }

  logger.trace('Checking wallets for top-up...');

  // Get the main wallet's SOL balance
  const mainWalletBalanceLamports = await connection.getBalance(wallet.publicKey);
  const mainWalletBalanceSOL = mainWalletBalanceLamports / LAMPORTS_PER_SOL;

  // Determine which wallets need a top-up
  const walletsToTopUp: PublicKey[] = [];

  for (const walletPubKey of wallets) {
    logger.trace(`Checking wallet ${walletPubKey.toBase58()}...`);
    // Get SOL balance
    const balanceLamports = await connection.getBalance(walletPubKey);
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;

    if (balanceSOL < THRESHOLD_SOL) {
      walletsToTopUp.push(walletPubKey);
    } else {
      logger.trace(`Wallet ${walletPubKey.toBase58()} has sufficient balance (${balanceSOL.toFixed(5)} SOL).`);
    }
  }

  if (walletsToTopUp.length === 0) {
    logger.info('No wallets need top-up at this time.');
    return;
  }

  // Calculate total SOL required (including transaction fees)
  const estimatedFeePerTransaction = 0.0005; // Approximate fee per transaction
  const totalSolRequired = walletsToTopUp.length * (SOL_DIST + estimatedFeePerTransaction);

  if (mainWalletBalanceSOL < totalSolRequired) {
    const message = `Insufficient SOL balance in main wallet. Required: ${totalSolRequired.toFixed(5)} SOL, Available: ${mainWalletBalanceSOL.toFixed(5)} SOL. Distribution skipped.`;
    logger.error(message);
    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message);
    return;
  }

  // Distribute SOL
  for (const recipientPubKey of walletsToTopUp) {
    try {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: recipientPubKey,
          lamports: Math.floor(SOL_DIST * LAMPORTS_PER_SOL),
        })
      );

      // Set a recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;

      // Sign the transaction with the main wallet's keypair
      transaction.sign(wallet);

      // Send the transaction using connection.sendRawTransaction
      const signature = await connection.sendRawTransaction(transaction.serialize());

      logger.info({ wallet: recipientPubKey.toBase58(), signature: signature, amount: SOL_DIST}, `Distribution complete!`);
      await telegramBot.sendMessage(
        TELEGRAM_CHAT_ID,
        `Distributed ${SOL_DIST} SOL to ${recipientPubKey.toBase58()}.\nTransaction signature: ${signature}`
      );
    } catch (error) {
      logger.error(`Failed to distribute SOL to ${recipientPubKey.toBase58()}:`, error);
      await telegramBot.sendMessage(
        TELEGRAM_CHAT_ID,
        `Failed to distribute SOL to ${recipientPubKey.toBase58()}.\nError: ${error}`
      );
    }
  }
}


const blacklist = loadBlacklist();

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
 
  const poolState = await PoolKeys.fetchPoolKeyInfo(connection, new PublicKey(TOKEN_ACCOUNT), quoteToken.mint) as LiquidityPoolKeysV4;
  listeners.on(`new_swap`, async(chunk: any) => {  
    const tx = await connection.getParsedTransaction(chunk.signature, { maxSupportedTransactionVersion: 0});
    if (!tx) {
      logger.error(`Transaction not found: ${chunk.signature}`);
      return;
    } else { 
      const buyerPublicKey = tx.transaction.message.accountKeys[0].pubkey.toBase58(); 
      const jupiterProgramId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"; // Jupiter Aggregator Program ID
      let isJupiter = false;
      // Get pre/post balances and account keys
      const preBalances = tx.meta?.preTokenBalances;
      const postBalances = tx.meta?.postTokenBalances;
      const accountKeys = tx.transaction.message.accountKeys;

      if (blacklist.has(buyerPublicKey)) { 
        return;
      }

      // **Check if Jupiter is in the transaction's account keys** 
      if (!accountKeys.some(account => account.pubkey.toBase58() === jupiterProgramId)) {  
        isJupiter = false;
      } else {  
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
        const preTokenAAmount = tokenAPreBalance?.uiTokenAmount.uiAmount || 0;
        const postTokenAAmount = tokenAPostBalance.uiTokenAmount.uiAmount || 0; 
        const preWsolAmountLamports = parseFloat(wsolPreBalance.uiTokenAmount.amount);
        const postWsolAmountLamports = parseFloat(wsolPostBalance.uiTokenAmount.amount); 

        if(isJupiter) {  
          if (postTokenAAmount > preTokenAAmount) {   
            logger.trace({ signature: chunk.signature }, `Jupiter Buy Swap`);
            logger.trace(`preTokenAAmount: ${preTokenAAmount}, postTokenAAmount: ${postTokenAAmount}`);
            logger.trace(`preWsolAmountLamports: ${preWsolAmountLamports}, postWsolAmountLamports: ${postWsolAmountLamports}`); 
            const buySwapAmountLamports = postWsolAmountLamports - preWsolAmountLamports; // Amount of WSOL swapped 
            const buyTokenAmount = postTokenAAmount - preTokenAAmount; // Amount of TokenA bought
              // Convert MINIMUM_BUY_TRIGGER from SOL to lamports
            const minimumBuyTriggerLamports = MINIMUM_BUY_TRIGGER * 1e9;
            logger.trace({ signature: chunk.signature }, `BuySwap: ${buySwapAmountLamports}, minimumBuyTriggerLamports: ${minimumBuyTriggerLamports}`);
            logger.trace({ signature: chunk.signature }, `Amount: ${buyTokenAmount}`);
            if (buySwapAmountLamports <= minimumBuyTriggerLamports) { 
              logger.trace({ signature: chunk.signature }, `Detected Swap below minimum trigger amount or not Buy`);
              return;
            } 
            await bot.sell(chunk.accountId, TOKEN_ACCOUNT, poolState, buyTokenAmount);
            return;
          } 
        } else { 
          if (postTokenAAmount < preTokenAAmount) { 
            
            logger.trace({ signature: chunk.signature }, `Raydium Buy Swap`); 
            const buySwapAmountLamports =  postWsolAmountLamports - preWsolAmountLamports; // Amount of WSOL swapped 
            const buyTokenAmount = preTokenAAmount - postTokenAAmount; // Amount of TokenA bought
            // Convert MINIMUM_BUY_TRIGGER from SOL to lamports
            const minimumBuyTriggerLamports = MINIMUM_BUY_TRIGGER * 1e9;
            logger.trace({ signature: chunk.signature }, `BuySwap: ${buySwapAmountLamports}, minimumBuyTriggerLamports: ${minimumBuyTriggerLamports}`);
            logger.trace({ signature: chunk.signature }, `Amount: ${buyTokenAmount}`);
            if (buySwapAmountLamports <= minimumBuyTriggerLamports) { 
              logger.trace({ signature: chunk.signature }, `Detected Swap below minimum trigger amount or not Buy`);
              return;
            }  
            await bot.sell(chunk.accountId, TOKEN_ACCOUNT, poolState, buyTokenAmount);
          } 
        }  
        
      } else {
        logger.error(`Could not find matching WSOL or TokenA accounts in the transaction.`);
      }
    }
  }); 

  printDetails(wallet, quoteToken, bot);

  setInterval(() => distributeSol(wallet), DIST_INTERVAL);
};

runListener();
