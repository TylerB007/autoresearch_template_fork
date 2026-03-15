import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from '../components/Skeleton';
import {
  getPositions,
  addPosition,
  updatePosition,
  deletePosition,
  type Position,
  type PositionInput,
} from '../api/client';
import StatusBadge from '../components/StatusBadge';
import StrategyForm, { STRATEGY_LABELS } from '../components/StrategyForm';
import ConfirmDialog from '../components/ConfirmDialog';
import { REFRESH_EVENT } from '../components/Navbar';

function PositionsTable({ positions, onEdit, onDelete, onOpen }: {
  positions: Position[];
  onEdit: (position: Position) => void;
  onDelete: (position: Position) => void;
  onOpen: (tokenId: number) => void;
}) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Token ID</th>
            <th>Pair</th>
            <th>Strategy</th>
            <th>Width</th>
            <th>Trigger</th>
            <th>Status</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => (
            <tr key={pos.token_id}>
              <td>
                <button onClick={() => onOpen(pos.token_id)} className="text-data text-sky-300 transition-colors hover:text-sky-200">
                  #{pos.token_id}
                </button>
              </td>
              <td className="font-medium text-white">{pos.pair}</td>
              <td className="text-slate-300">{STRATEGY_LABELS[pos.strategy] || pos.strategy}</td>
              <td className="text-data text-slate-200">{pos.width_ticks}{pos.width_percentage ? ` (~${pos.width_percentage}%)` : ''}</td>
              <td className="text-data text-slate-200">{pos.trigger_distance_ticks}{pos.trigger_percentage ? ` (~${pos.trigger_percentage}%)` : ''}</td>
              <td><StatusBadge inRange={pos.inRange} /></td>
              <td>
                <div className="flex justify-end gap-2">
                  <button onClick={() => onEdit(pos)} className="action-button action-button-secondary min-h-[2.4rem] px-3 py-2 text-xs">
                    Edit
                  </button>
                  <button onClick={() => onDelete(pos)} className="action-button min-h-[2.4rem] bg-rose-500/12 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/18">
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FormModal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="modal-panel w-full max-w-xl p-6">
        <p className="eyebrow mb-2">Position Configuration</p>
        <h3 className="mb-5 text-xl font-semibold text-white">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export default function Positions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editPosition, setEditPosition] = useState<Position | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Position | null>(null);
  const navigate = useNavigate();

  const fetchPositions = useCallback(() => {
    setLoading(true);
    getPositions()
      .then(setPositions)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, fetchPositions);
    return () => window.removeEventListener(REFRESH_EVENT, fetchPositions);
  }, [fetchPositions]);

  const handleAdd = async (data: PositionInput) => {
    try {
      await addPosition(data);
      setShowAddModal(false);
      fetchPositions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add position');
    }
  };

  const handleEdit = async (data: PositionInput) => {
    if (!editPosition) return;
    try {
      await updatePosition(editPosition.token_id, {
        strategy: data.strategy,
        width_ticks: data.width_ticks,
        trigger_distance_ticks: data.trigger_distance_ticks,
      });
      setEditPosition(null);
      fetchPositions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update position');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deletePosition(deleteTarget.token_id);
      setDeleteTarget(null);
      fetchPositions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete position');
    }
  };

  if (loading) {
    return (
      <div className="page-section">
        <section className="page-hero animate-fade-rise">
          <Skeleton className="mb-2 h-4 w-28" />
          <Skeleton className="mb-3 h-10 w-80" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </section>
        <div className="panel p-5">
          <div className="space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <section className="page-hero animate-fade-rise">
        <div className="page-grid gap-5 lg:grid-cols-[1.5fr_0.8fr] lg:items-end">
          <div>
            <p className="eyebrow">Position registry</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-0.05em] text-white sm:text-5xl">
              Manage the monitored LP universe without losing execution context.
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
              This workspace stays operational rather than decorative: token IDs, strategy presets, width controls, and trigger distances remain dense, readable, and safe to edit on mobile or desktop.
            </p>
          </div>
          <div className="panel-muted p-4">
            <p className="metric-card-label">Configured Positions</p>
            <p className="mt-2 text-4xl font-semibold tracking-[-0.05em] text-white">{positions.length}</p>
            <p className="mt-2 text-sm text-slate-400">Add, adjust, or retire management rules without changing route semantics.</p>
          </div>
        </div>
      </section>

      {error && <div className="banner banner-danger"><p className="text-sm text-slate-200">{error}</p></div>}

      <section className="panel p-5">
        <div className="panel-header">
          <div>
            <p className="panel-title">Configuration Table</p>
            <p className="panel-copy">Token-local configuration with direct access into the operational workspace.</p>
          </div>
          <button onClick={() => setShowAddModal(true)} className="action-button action-button-primary">
            Add Position
          </button>
        </div>
        <div className="mt-5">
          {positions.length === 0 ? (
            <div className="empty-state">No positions are configured yet.</div>
          ) : (
            <PositionsTable
              positions={positions}
              onEdit={setEditPosition}
              onDelete={setDeleteTarget}
              onOpen={(nextTokenId) => navigate(`/positions/${nextTokenId}`)}
            />
          )}
        </div>
      </section>

      {showAddModal && (
        <FormModal title="Add Position">
          <StrategyForm onSubmit={handleAdd} onCancel={() => setShowAddModal(false)} submitLabel="Add Position" />
        </FormModal>
      )}

      {editPosition && (
        <FormModal title={`Edit Position #${editPosition.token_id}`}>
          <StrategyForm
            initialData={{
              token_id: editPosition.token_id,
              strategy: editPosition.strategy,
              width_ticks: editPosition.width_ticks,
              trigger_distance_ticks: editPosition.trigger_distance_ticks,
            }}
            showTokenId={false}
            onSubmit={handleEdit}
            onCancel={() => setEditPosition(null)}
            submitLabel="Save Changes"
          />
        </FormModal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Remove Position"
          message={`Are you sure you want to remove position #${deleteTarget.token_id}? This stops the bot from managing that position from config.yaml.`}
          confirmLabel="Remove"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
