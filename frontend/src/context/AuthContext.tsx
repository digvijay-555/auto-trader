import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { hasWriteAccess as checkWriteAccess, setToken, clearToken, onAuthChange } from '../lib/auth';

interface AuthContextType {
  hasWriteAccess: boolean;
  isUnlockModalOpen: boolean;
  unlockReason: string | null;
  openUnlockModal: (reason?: string) => void;
  closeUnlockModal: () => void;
  lock: () => void;
  unlock: (token: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [hasWriteAccess, setHasWriteAccess] = useState<boolean>(() => checkWriteAccess());
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState<boolean>(false);
  const [unlockReason, setUnlockReason] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe to reactive auth changes (same-tab, other tabs, login, logout)
    const unsubscribe = onAuthChange((valid) => {
      setHasWriteAccess(valid);
      if (valid) {
        setIsUnlockModalOpen(false);
        setUnlockReason(null);
      }
    });

    const handleAuthChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ hasWrite?: boolean }>;
      if (typeof customEvent.detail?.hasWrite === 'boolean') {
        setHasWriteAccess(customEvent.detail.hasWrite);
        if (customEvent.detail.hasWrite) {
          setIsUnlockModalOpen(false);
          setUnlockReason(null);
        }
      }
    };

    const handleUnauthorizedEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ isMutation?: boolean }>;
      // Only revoke write access and open the modal if an active mutation request (order, update, etc.) failed due to unauthorized.
      // Never disrupt the user or revoke write access during passive background polling or read requests!
      if (customEvent.detail?.isMutation) {
        setHasWriteAccess(false);
        setIsUnlockModalOpen(true);
        setUnlockReason('Session expired or unauthorized. Enter passkey to restore write access.');
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('at_auth_change', handleAuthChange);
      window.addEventListener('at_unauthorized', handleUnauthorizedEvent);
    }

    return () => {
      unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('at_auth_change', handleAuthChange);
        window.removeEventListener('at_unauthorized', handleUnauthorizedEvent);
      }
    };
  }, []);

  const openUnlockModal = useCallback((reason?: string) => {
    setUnlockReason(reason || null);
    setIsUnlockModalOpen(true);
  }, []);

  const closeUnlockModal = useCallback(() => {
    setIsUnlockModalOpen(false);
    setUnlockReason(null);
  }, []);

  const unlock = useCallback((token: string) => {
    setToken(token);
    setHasWriteAccess(true);
    setIsUnlockModalOpen(false);
    setUnlockReason(null);
  }, []);

  const lock = useCallback(() => {
    clearToken();
    setHasWriteAccess(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        hasWriteAccess,
        isUnlockModalOpen,
        unlockReason,
        openUnlockModal,
        closeUnlockModal,
        lock,
        unlock,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
