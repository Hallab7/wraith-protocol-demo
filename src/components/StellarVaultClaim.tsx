import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { NetworkMismatchModal } from '@/components/NetworkMismatchModal';
import { StellarLink } from '@/components/StellarLink';
import { useStellarWallet } from '@/context/StellarWalletContext';
import { useVaultDeposits } from '@/hooks/useVaultDeposits';
import { getVaultActions, submitVaultAction } from '@/lib/stellar/vaultStatus';

export function StellarVaultClaim() {
  const { address, signTransaction, isNetworkMismatch, freighterNetwork } = useStellarWallet();
  const { deposits, loading, error, refresh } = useVaultDeposits(address, freighterNetwork);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  if (!address) {
    return (
      <div className="py-12 text-center">
        <p className="font-heading text-sm uppercase tracking-widest text-outline">
          Connect Wallet
        </p>
        <p className="mt-2 font-body text-xs text-on-surface-variant">
          Connect your Freighter wallet to claim vault deposits.
        </p>
      </div>
    );
  }

  const claimable = deposits.filter((deposit) => getVaultActions(deposit, address).canClaim);

  const handleClaim = async (depositId: string) => {
    if (isNetworkMismatch) {
      setShowNetworkModal(true);
      return;
    }
    setClaimingId(depositId);
    setClaimError('');
    try {
      const hash = await submitVaultAction({
        action: 'claim',
        depositId,
        actor: address,
        signTransaction,
      });
      setTxHash(hash);
      await refresh();
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {(claimError || error) && <p className="text-sm text-error">{claimError || error}</p>}
      {txHash && (
        <div className="border border-tertiary bg-tertiary/5 p-4">
          <p className="font-heading text-xs font-semibold uppercase tracking-widest text-tertiary">
            Claim Confirmed
          </p>
          <StellarLink
            value={txHash}
            type="tx"
            className="mt-2 max-w-full"
            linkClassName="text-xs"
          />
        </div>
      )}

      {!loading && claimable.length === 0 && !error && (
        <div className="py-12 text-center">
          <p className="font-heading text-sm uppercase tracking-widest text-outline">
            No Claimable Deposits
          </p>
          <p className="mt-2 font-body text-xs text-on-surface-variant">
            The contract has no unlocked deposits authorized for this wallet.
          </p>
        </div>
      )}

      {claimable.map((deposit) => (
        <div key={deposit.id} className="border border-outline-variant bg-surface-container p-5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
            Deposit ID
          </span>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate font-mono text-xs text-primary">{deposit.id}</span>
            <CopyButton text={deposit.id} />
          </div>
          <p className="mt-4 font-heading text-lg font-bold text-on-surface">
            {deposit.amount} XLM
          </p>
          <button
            onClick={() => void handleClaim(deposit.id)}
            disabled={claimingId === deposit.id}
            className="mt-4 h-11 w-full bg-primary font-heading text-[13px] font-semibold uppercase tracking-widest text-surface disabled:opacity-30"
          >
            {claimingId === deposit.id ? 'Claiming...' : 'Claim'}
          </button>
        </div>
      ))}

      {showNetworkModal && <NetworkMismatchModal onClose={() => setShowNetworkModal(false)} />}
    </div>
  );
}
