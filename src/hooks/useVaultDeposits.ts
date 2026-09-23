import { useCallback, useEffect, useState } from 'react';
import { loadVaultDeposits, type OnChainVaultDeposit } from '@/lib/stellar/vaultStatus';

export function useVaultDeposits(address: string | null, networkKey: string | null) {
  const [deposits, setDeposits] = useState<OnChainVaultDeposit[]>([]);
  const [currentLedger, setCurrentLedger] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!address) {
      setDeposits([]);
      setCurrentLedger(0);
      return;
    }
    setLoading(true);
    try {
      const result = await loadVaultDeposits(address);
      setDeposits(result.deposits);
      setCurrentLedger(result.currentLedger);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read vault state');
    } finally {
      setLoading(false);
    }
  }, [address, networkKey]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { deposits, currentLedger, loading, error, refresh };
}
