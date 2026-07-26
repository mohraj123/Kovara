export class TransactionLogger {
  logRollback(transactionId: string, error: Error, duration: number): void {
    const log = {
      timestamp: new Date(),
      transactionId,
      action: 'ROLLBACK',
      error: error.message,
      duration: duration + 'ms'
    };
    console.log('Transaction:', log);
  }

  logCommit(transactionId: string, duration: number): void {
    console.log('Transaction:', { action: 'COMMIT', transactionId, duration });
  }
}
