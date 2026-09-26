interface CancelConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  operationName?: string;
}

export function CancelConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  operationName,
}: CancelConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="modal modal-open z-60"
      role="dialog"
      aria-labelledby="cancel-dialog-title"
      aria-modal="true"
    >
      <div className="modal-box max-w-md border border-base-300 shadow-2xl">
        <h3
          id="cancel-dialog-title"
          className="text-base font-bold text-base-content"
        >
          Cancel this operation?
        </h3>
        {operationName && (
          <p className="mt-1 font-mono text-xs text-base-content/60">
            {operationName}
          </p>
        )}
        <p className="mt-3 text-sm text-base-content/70">
          Already-dispatched provider requests may still complete and may still
          incur cost. No additional checks will be started.
        </p>

        <div className="modal-action mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            Keep running
          </button>
          <button
            type="button"
            className="btn btn-warning btn-sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Cancel operation
          </button>
        </div>
      </div>
      <div
        className="modal-backdrop bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
    </div>
  );
}
