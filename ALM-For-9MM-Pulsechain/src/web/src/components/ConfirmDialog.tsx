interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="modal-panel mx-4 w-full max-w-md p-6">
        <p className="eyebrow mb-2">Confirm Action</p>
        <h3 className="mb-2 text-xl font-semibold text-white">{title}</h3>
        <p className="mb-6 text-sm leading-6 text-slate-300">{message}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            onClick={onConfirm}
            className="action-button action-button-danger flex-1"
          >
            {confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="action-button action-button-secondary flex-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
