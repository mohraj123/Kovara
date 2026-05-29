"use client";

import React from "react";
import type { Notification } from "../context/NotificationContext";

interface TxNotificationProps {
  notification: Notification;
  onClose: () => void;
}

export function TxNotification({ notification, onClose }: TxNotificationProps) {
  const isPending = notification.status === "pending";
  const isSuccess = notification.status === "success";
  const isError = notification.status === "error";

  const getStellarExpertLink = (hash: string) => {
    return `https://stellar.expert/explorer/testnet/tx/${hash}`;
  };

  return (
    <div
      style={{
        background: "var(--color-bg)",
        border: `1px solid ${
          isError ? "var(--color-like)" : isSuccess ? "var(--color-success)" : "var(--color-primary)"
        }`,
        borderRadius: "8px",
        padding: "16px",
        width: "300px",
        boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {isPending && <span style={styles.spinner} aria-hidden="true" />}
          {isSuccess && <span aria-hidden="true" style={{ color: "var(--color-success)" }}>✅</span>}
          {isError && <span aria-hidden="true" style={{ color: "var(--color-like)" }}>❌</span>}
          
          <strong style={{ fontSize: "1rem" }}>
            {isPending ? "Transaction submitted..." : isSuccess ? "Success" : "Error"}
          </strong>
        </div>
        <button
          onClick={onClose}
          aria-label="Close notification"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "1.2rem",
            color: "var(--color-text-secondary)",
          }}
        >
          ×
        </button>
      </div>

      <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--color-text-secondary)" }}>
        {notification.message}
      </p>

      {isSuccess && notification.txHash && (
        <a
          href={getStellarExpertLink(notification.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: "0.85rem",
            color: "var(--color-primary)",
            textDecoration: "none",
          }}
        >
          View on Stellar Expert ↗
        </a>
      )}

      {isError && (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
          Please try again.
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  spinner: {
    display: "inline-block",
    width: "16px",
    height: "16px",
    border: "2px solid var(--color-border)",
    borderTopColor: "var(--color-primary)",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  }
};
