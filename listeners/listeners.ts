import { Token, TOKEN_PROGRAM_ID } from '@raydium-io/raydium-sdk';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js'; 
import { EventEmitter } from 'events';
import Client, {
  CommitmentLevel,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterAccountsFilter,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
} from '@triton-one/yellowstone-grpc';  
import { logger } from '../helpers';  
import { SubscribeRequestPing } from '@triton-one/yellowstone-grpc/dist/grpc/geyser'; 

import { TransactionFormatter } from '../utils/transaction-formater';  
import { RaydiumAmmParser } from '../utils/raydium-amm-parser';

interface SubscribeRequest {
  accounts: { [key: string]: SubscribeRequestFilterAccounts };
  slots: { [key: string]: SubscribeRequestFilterSlots };
  transactions: { [key: string]: SubscribeRequestFilterTransactions };
  transactionsStatus: { [key: string]: SubscribeRequestFilterTransactions };
  blocks: { [key: string]: SubscribeRequestFilterBlocks };
  blocksMeta: { [key: string]: SubscribeRequestFilterBlocksMeta };
  entry: { [key: string]: SubscribeRequestFilterEntry };
  commitment?: CommitmentLevel | undefined;
  accountsDataSlice: SubscribeRequestAccountsDataSlice[];
  ping?: SubscribeRequestPing | undefined;
}
 
const TXN_FORMATTER = new TransactionFormatter();
const RAYDIUM_PARSER = new RaydiumAmmParser();
const RAYDIUM_PUBLIC_KEY = RaydiumAmmParser.PROGRAM_ID;

export class GrpcListeners extends EventEmitter {
  private accountStream: any;  

  constructor(private readonly client: Client, private readonly connection: Connection) {
    super();  
  }

  public async start(config: { walletPublicKey: PublicKey; quoteToken: Token; autoSell: boolean;}) {  
    await this.subscribeToRaydiumPools(config); 
  } 
 
  private async subscribeToRaydiumPools(config: { walletPublicKey: PublicKey }) {
    logger.info({ wallet: config.walletPublicKey }, 'Subscribing to Account Stream ');
    this.accountStream = await this.client.subscribe();

    this.accountStream.on('data', (chunk: any) => { 
      this.handlePoolStreamData(chunk);
    });

    this.accountStream.on('error', (err: any) => { 
      new Promise((resolve) => setTimeout(resolve, 1000));
      logger.warn('ReSubscribed to Account Pool Streams:', err);
    }); 

    const req: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        mpox: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude: [], //input wallet
          accountExclude: [],
          accountRequired: [RAYDIUM_PUBLIC_KEY.toBase58(),'2Z9SGDsHWvdKddAkfQS5QJ7ecaj18cwcHWcsDy9CrwuN'],
        },
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: undefined,
      commitment: CommitmentLevel.CONFIRMED,
    };

    try {   
      await this.sendRequest(this.accountStream, req); 
    } catch (error) { 
      throw error;
    }
  }

  private async handlePoolStreamData(chunk: any) { 
    if (chunk?.transaction) {
      const txn = TXN_FORMATTER.formTransactionFromJson(
        chunk.transaction,
        Date.now(),
      );
      const decodedRaydiumIxs = this.decodeRaydiumTxn(txn);

      if (!decodedRaydiumIxs?.length) return;
      const createPoolIx = decodedRaydiumIxs.find((decodedRaydiumIx) => {
        if (
          decodedRaydiumIx.name === "swapIn" ||
          decodedRaydiumIx.name === "swapOut"
        ) {
          return decodedRaydiumIx;
        }
      });
       if (createPoolIx) {
        const info  = this.getMintToken(chunk);
        const stringify : any = this.stringifyWithBigInt(createPoolIx.args);
        // console.log(
        //   `Signature: ${txn.transaction.signatures[0]}
        //    CA : ${info.ca}
        //    Pool Info : ${stringify}
        //    Owner : ${info.signer}
        //   `
        // );
        this.emit('new_swap', {
          signature: txn.transaction.signatures[0],
          ca: info.ca,
          poolInfo: stringify,
          owner: info.signer
        });
      }
    }
  }

  private stringifyWithBigInt(obj: any): string {
    return JSON.stringify(obj, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value);
  }

  private decodeRaydiumTxn(tx: VersionedTransactionResponse) {
    if (tx.meta?.err) return;
  
    const allIxs = TXN_FORMATTER.flattenTransactionResponse(tx);
  
    const raydiumIxs = allIxs.filter((ix) =>
      ix.programId.equals(new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')),
    );
  
    const decodedIxs = raydiumIxs.map((ix) =>
      RAYDIUM_PARSER.parseInstruction(ix),
    );
  
    return decodedIxs;
  }

  private getMintToken(tx: any){
    const data : any[] = tx.transaction.transaction.meta.preTokenBalances;
    const filter = data.filter((t)=> t.mint !== "So11111111111111111111111111111111111111112")
    const ca = filter[0].mint;
    const signer = filter[0].owner;
     return {
      ca,
      signer
    };
  } 

  private async sendRequest(stream: any, request: SubscribeRequest) {
    if (!stream) {
      throw new Error('Stream is not initialized.');
    }

    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: any) => {
        if (err) {
          logger.error('Error writing to gRPC stream:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }  

  public async stop(stream: string) {
    try {
      if (stream === 'accountStream' && this.accountStream) {
        await this.stopStream(this.accountStream, 'Account pool stream');
        this.accountStream = null; // Ensure the reference is nullified
      } 
    } catch (error) {
      logger.warn(`Failed to stop ${stream}:`, error);
    }
  }
  
  private async stopStream(stream: any, streamName: string) {
    try {
      stream.end(); // Gracefully end the stream
      stream.removeAllListeners(); // Remove all listeners to prevent memory leaks 
    } catch (error) {
      logger.warn(`Failed to stop ${streamName}:`, error);
    }
  }
}