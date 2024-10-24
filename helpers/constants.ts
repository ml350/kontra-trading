import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { logger } from './logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);
export const GRPC_ENDPOINT = retrieveEnvVariable('GRPC_ENDPOINT', logger);
export const GRPC_TOKEN = retrieveEnvVariable('GRPC_TOKEN', logger);

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const ONE_TOKEN_AT_A_TIME = retrieveEnvVariable('ONE_TOKEN_AT_A_TIME', logger) === 'true';
export const COMPUTE_UNIT_LIMIT = Number(retrieveEnvVariable('COMPUTE_UNIT_LIMIT', logger));
export const COMPUTE_UNIT_PRICE = Number(retrieveEnvVariable('COMPUTE_UNIT_PRICE', logger));
export const PRE_LOAD_EXISTING_MARKETS = retrieveEnvVariable('PRE_LOAD_EXISTING_MARKETS', logger) === 'true'; 
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger);
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger);

// Buy 
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger); 

// Sell
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));  
export const SELL_SLIPPAGE = Number(retrieveEnvVariable('SELL_SLIPPAGE', logger));

export const TOKEN_ACCOUNT = retrieveEnvVariable('TOKEN_ACCOUNT', logger);
export const PRICE_SET = Number(retrieveEnvVariable('PRICE_SET', logger));
export const MINIMUM_BUY_TRIGGER = Number(retrieveEnvVariable('MINIMUM_BUY_TRIGGER', logger));
export const AVG_SELL_AMOUNT = Number(retrieveEnvVariable('AVG_SELL_AMOUNT', logger));
export const HIGH_SELL_AMOUNT = Number(retrieveEnvVariable('HIGH_SELL_AMOUNT', logger));
export const LOW_SELL_AMOUNT = Number(retrieveEnvVariable('LOW_SELL_AMOUNT', logger));
 