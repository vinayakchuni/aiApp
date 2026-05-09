'use client';

import { useEffect, useState } from 'react';
import type { UserSettingsResponse } from '@ai-app/shared';
import { apiPatch } from '../lib/api';

interface Props {
  open: boolean;
  settings: UserSettingsResponse | null;
  onClose: () => void;
  onSaved: (settings: UserSettingsResponse) => void;
}

export function SettingsModal({ open, settings, onClose, onSaved }: Props) {
  const [model, setModel] = useState(settings?.preferredModel ?? '');
  const [streaming, setStreaming] = useState(settings?.streamingEnabled ?? true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && settings) {
      setModel(settings.preferredModel);
      setStreaming(settings.streamingEnabled);
      setError(null);
    }
  }, [open, settings]);

  if (!open || !settings) return null;

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    try {
      const res = await apiPatch('/api/users/settings', {
        preferredModel: model,
        streamingEnabled: streaming,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Could not save settings');
        return;
      }
      onSaved(data.settings as UserSettingsResponse);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Could not save settings');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="settings-title" className="text-lg font-semibold text-gray-900">
          Settings
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Configure the model and response mode used for new messages.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="model-select" className="block text-sm font-medium text-gray-800">
              Model
            </label>
            <select
              id="model-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isSaving}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {settings.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Streaming responses</p>
              <p className="text-xs text-gray-500">
                Show tokens as they arrive instead of waiting for the full response.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={streaming}
              onClick={() => setStreaming((s) => !s)}
              disabled={isSaving}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
                streaming ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                  streaming ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
