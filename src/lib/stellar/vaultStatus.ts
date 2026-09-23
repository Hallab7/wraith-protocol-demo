import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { STELLAR_NETWORK } from '@/config';

const EVENT_LOOKBACK_LEDGERS = 17_280;
const DUMMY_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH';

export type VaultDepositState =
  | 'pending'
  | 'claimable'
  | 'expired'
  | 'claimed'
  | 'refunded'
  | 'failed';

export interface OnChainVaultDeposit {
  id: string;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  unlockLedger: number;
  refundAfter: number;
  createdLedger: number;
  txHash: string;
  state: VaultDepositState;
}

type TerminalState = 'claimed' | 'refunded';

type VaultServer = {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(request: Record<string, unknown>): Promise<any>;
  getAccount(address: string): Promise<Account>;
  simulateTransaction(transaction: unknown): Promise<any>;
  sendTransaction(transaction: unknown): Promise<any>;
  pollTransaction(hash: string, options?: { attempts?: number }): Promise<any>;
  assembleTransaction?: (
    transaction: unknown,
    simulation: unknown,
  ) => { build(): { toXDR(): string } } | Promise<{ build(): { toXDR(): string } }>;
};

function runtimeWindow() {
  return window as Window & {
    __WRAITH_CONFIG__?: { stellarVaultContractId?: string };
    sorobanServerMock?: unknown;
  };
}

export function getVaultStatusContractId(): string {
  return (
    runtimeWindow().__WRAITH_CONFIG__?.stellarVaultContractId ||
    import.meta.env.VITE_STELLAR_VAULT_CONTRACT_ID ||
    ''
  );
}

function getServer(): VaultServer {
  const mock = runtimeWindow().sorobanServerMock;
  return (mock || new rpc.Server(STELLAR_NETWORK.rpcUrl)) as VaultServer;
}

function valueToString(value: unknown): string {
  if (value && typeof value === 'object' && 'toString' in value) return value.toString();
  return String(value ?? '');
}

function normalizeDepositId(value: unknown): string {
  const native = value instanceof xdr.ScVal ? scValToNative(value) : value;
  if (native instanceof Uint8Array) return Buffer.from(native).toString('hex');
  const text = valueToString(native).replace(/^0x/, '');
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  throw new Error('Vault event contained an invalid deposit ID');
}

function toNative(value: unknown): unknown {
  return value instanceof xdr.ScVal ? scValToNative(value) : value;
}

function toRecord(value: unknown): Record<string, unknown> {
  const native = toNative(value);
  if (native instanceof Map) return Object.fromEntries(native.entries());
  return native && typeof native === 'object' ? (native as Record<string, unknown>) : {};
}

function toTuple(value: unknown): unknown[] {
  const native = toNative(value);
  return Array.isArray(native) ? native : [];
}

function stroopsToXlm(value: unknown): string {
  const stroops = BigInt(valueToString(value) || '0');
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function deriveVaultState(
  currentLedger: number,
  unlockLedger: number,
  refundAfter: number,
  terminalState?: TerminalState,
  readFailed = false,
): VaultDepositState {
  if (terminalState) return terminalState;
  if (readFailed) return 'failed';
  if (currentLedger < unlockLedger) return 'pending';
  if (currentLedger < refundAfter) return 'claimable';
  return 'expired';
}

export function getVaultActions(deposit: OnChainVaultDeposit, address: string) {
  return {
    canClaim: deposit.state === 'claimable' && deposit.recipient === address,
    canRefund: deposit.state === 'expired' && deposit.sender === address,
  };
}

async function readActiveDeposit(
  server: VaultServer,
  contractId: string,
  depositId: string,
): Promise<Record<string, unknown>> {
  const transaction = new TransactionBuilder(new Account(DUMMY_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK.networkPassphrase,
  })
    .addOperation(
      new Contract(contractId).call(
        'get_deposit',
        xdr.ScVal.scvBytes(Buffer.from(depositId, 'hex')),
      ),
    )
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if ('error' in simulation || !simulation.result?.retval) {
    throw new Error('Deposit is no longer readable from contract storage');
  }
  return toRecord(simulation.result.retval);
}

export async function loadVaultDeposits(address: string): Promise<{
  currentLedger: number;
  deposits: OnChainVaultDeposit[];
}> {
  const contractId = getVaultStatusContractId();
  if (!contractId) throw new Error('Stealth vault contract is not configured for Stellar Testnet');

  const server = getServer();
  const latest = await server.getLatestLedger();
  const currentLedger = latest.sequence;
  const response = await server.getEvents({
    startLedger: Math.max(1, currentLedger - EVENT_LOOKBACK_LEDGERS),
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit: 10_000,
  });

  const deposits = new Map<string, Partial<OnChainVaultDeposit>>();
  const terminalStates = new Map<string, TerminalState>();

  for (const event of response.events ?? []) {
    const eventName = valueToString(toNative(event.topic?.[0]));
    if (!['deposit', 'claim', 'refund'].includes(eventName) || !event.topic?.[1]) continue;

    const id = normalizeDepositId(event.topic[1]);
    const values = toTuple(event.value);
    const existing = deposits.get(id) ?? { id };

    if (eventName === 'deposit') {
      deposits.set(id, {
        ...existing,
        id,
        sender: valueToString(values[0]),
        amount: stroopsToXlm(values[1]),
        asset: valueToString(values[2]),
        unlockLedger: Number(values[3] ?? 0),
        createdLedger: Number(event.ledger ?? 0),
        txHash: valueToString(event.txHash),
      });
    } else {
      terminalStates.set(id, eventName === 'claim' ? 'claimed' : 'refunded');
      deposits.set(id, {
        ...existing,
        id,
        ...(eventName === 'claim'
          ? { recipient: valueToString(values[0]) }
          : { sender: valueToString(values[0]) }),
        amount: stroopsToXlm(values[1]),
        txHash: valueToString(event.txHash),
      });
    }
  }

  const resolved = await Promise.all(
    Array.from(deposits.values()).map(async (deposit): Promise<OnChainVaultDeposit> => {
      const id = deposit.id as string;
      const terminalState = terminalStates.get(id);
      let readFailed = false;
      let entry: Record<string, unknown> = {};
      if (!terminalState) {
        try {
          entry = await readActiveDeposit(server, contractId, id);
        } catch {
          readFailed = true;
        }
      }

      const sender = valueToString(entry.sender ?? deposit.sender);
      const recipient = valueToString(entry.recipient ?? deposit.recipient);
      const unlockLedger = Number(
        entry.unlock_ledger ?? entry.unlockLedger ?? deposit.unlockLedger ?? 0,
      );
      const refundAfter = Number(entry.refund_after ?? entry.refundAfter ?? 0);
      const amount =
        entry.amount !== undefined ? stroopsToXlm(entry.amount) : valueToString(deposit.amount);

      return {
        id,
        sender,
        recipient,
        amount,
        asset: valueToString(entry.asset ?? deposit.asset),
        unlockLedger,
        refundAfter,
        createdLedger: Number(deposit.createdLedger ?? 0),
        txHash: valueToString(deposit.txHash),
        state: deriveVaultState(
          currentLedger,
          unlockLedger,
          refundAfter,
          terminalState,
          readFailed,
        ),
      };
    }),
  );

  return {
    currentLedger,
    deposits: resolved
      .filter((deposit) => deposit.sender === address || deposit.recipient === address)
      .sort((a, b) => b.createdLedger - a.createdLedger),
  };
}

export async function submitVaultAction(params: {
  action: 'claim' | 'refund';
  depositId: string;
  actor: string;
  signTransaction: (xdr: string) => Promise<string>;
}): Promise<string> {
  const contractId = getVaultStatusContractId();
  if (!contractId) throw new Error('Stealth vault contract is not configured for Stellar Testnet');

  const server = getServer();
  const sourceAccount = await server.getAccount(params.actor);
  const depositId = xdr.ScVal.scvBytes(Buffer.from(params.depositId, 'hex'));
  const operation =
    params.action === 'claim'
      ? new Contract(contractId).call('claim', depositId, new Address(params.actor).toScVal())
      : new Contract(contractId).call('refund', depositId);
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if ('error' in simulation) throw new Error(String(simulation.error));
  const assembled = server.assembleTransaction
    ? await server.assembleTransaction(transaction, simulation)
    : rpc.assembleTransaction(transaction, simulation);
  const signedXdr = await params.signTransaction(assembled.build().toXDR());
  const submitted = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, STELLAR_NETWORK.networkPassphrase),
  );
  if (submitted.status === 'ERROR' || !submitted.hash) {
    throw new Error(submitted.errorResult?.toString?.() || 'Vault transaction submission failed');
  }
  const result = await server.pollTransaction(submitted.hash, { attempts: 30 });
  if (result.status !== 'SUCCESS') throw new Error(`Vault ${params.action} failed on-chain`);
  return submitted.hash;
}
