import React from 'react';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { PasskeyScreen } from './PasskeyScreen';

function AuthModalOverlay() {
  const { isUnlockModalOpen, closeUnlockModal, unlockReason, unlock } = useAuth();

  if (!isUnlockModalOpen) return null;

  return (
    <PasskeyScreen
      onSuccess={(token?: string) => {
        if (token) {
          unlock(token);
        } else {
          closeUnlockModal();
        }
      }}
      onClose={closeUnlockModal}
      reason={unlockReason}
    />
  );
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {children}
      <AuthModalOverlay />
    </AuthProvider>
  );
}
