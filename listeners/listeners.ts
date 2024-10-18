import { Token } from '@raydium-io/raydium-sdk';
import { Connection, PublicKey } from '@solana/web3.js'; 
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
export class GrpcListeners extends EventEmitter {
  private accountStream: any;  

  constructor(private readonly client: Client, private readonly connection: Connection) {
    super(); 
  
  }

  public async start(config: { walletPublicKey: PublicKey; quoteToken: Token; autoSell: boolean; cacheNewMarkets: boolean; }) {  
    await this.subscribeToRaydiumPools(config); 
  } 
 

  private async subscribeToRaydiumPools(config: { walletPublicKey: PublicKey }) {
    this.accountStream = await this.client.subscribe();

    this.accountStream.on('data', (chunk: any) => { 
      this.handlePoolStreamData(chunk);
    });

    this.accountStream.on('error', (err: any) => { 
      new Promise((resolve) => setTimeout(resolve, 1000));
      logger.warn('ReSubscribed to Account Pool Streams:', err);
    }); 

    const req: SubscribeRequest = {
      slots: {},
      accounts: {
        "spl": {
          account: [config.walletPublicKey.toBase58()],
          owner: [],
          filters: [],
        },
      },
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };

    try {   
      await this.sendRequest(this.accountStream, req); 
    } catch (error) { 
      throw error;
    }
  }

  private async handlePoolStreamData(chunk: any) { 
    if(chunk?.account?.account){
      const txn = await TXN_FORMATTER.formTransactionFromJson(
       chunk?.account?.account,
      )
      console.log(txn);
    } 
  }
  
  // private async decodeRaydiumTxn(tx: VersionedTransactionResponse) {
  //   if (tx.meta?.err) return;
  
  //   const allIxs = TXN_FORMATTER.flattenTransactionResponse(tx);
  
  //   const raydiumIxs = allIxs.filter((ix) =>
  //     ix.programId.equals(RAYDIUM_PUBLIC_KEY),
  //   );
  
  //   const decodedIxs = raydiumIxs.map((ix) =>
  //     raydiumAmmParser.parseInstruction(ix),
  //   );
  
  //   return decodedIxs;
  // }

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