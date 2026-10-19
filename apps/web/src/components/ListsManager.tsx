"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";
import { createList, deleteList, fetchLists, renameList } from "../lib/api";
import { ghostButton, inputClass, primaryButton } from "../lib/ui";
import { MAX_FILE_BYTES, buildPersonalizedRecipients, parseCsvData, parseRecipients, prettyDate } from "../lib/utils";
import type { MailingList, MailingListRecipient } from "../lib/types";

export function ListsManager({
  onError,
  onMessage,
}: {
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLists(await fetchLists());
    } catch {
      onError("Could not load mailing lists.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const parsed = parseRecipients(text);

  async function onFile(file?: File) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return onError("File must be smaller than 5 MB.");
    try {
      setText(await file.text());
    } catch {
      onError("Could not read the selected file.");
    }
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return onError("Give the list a name.");
    if (!parsed.unique.length) return onError("Add at least one valid email address.");

    // Keep CSV columns (for example name and place) with each recipient.
    // Plain email lists remain fully supported and simply have empty fields.
    let recipientDetails: MailingListRecipient[] = parsed.unique.map((email) => ({ email, fields: {} }));
    const csv = parseCsvData(text);
    if (csv.suggestedEmailColumn) {
      const personalized = buildPersonalizedRecipients(csv, csv.suggestedEmailColumn);
      if (personalized.recipients.length > 0) {
        recipientDetails = personalized.recipients.map(({ email, fields }) => {
          const customFields = Object.fromEntries(
            Object.entries(fields).filter(([key]) =>
              key !== csv.suggestedEmailColumn &&
              key.trim().toLowerCase().replace(/[^a-z0-9]/g, "") !== "email",
            ),
          );
          return { email, fields: customFields };
        });
      }
    }

    setSaving(true);
    try {
      await createList(trimmed, recipientDetails);
      setName("");
      setText("");
      onMessage(`Saved "${trimmed}" with ${recipientDetails.length} recipients.`);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the list.");
    } finally {
      setSaving(false);
    }
  }

  async function rename(list: MailingList) {
    const next = window.prompt("Rename list", list.name)?.trim();
    if (!next || next === list.name) return;
    try {
      await renameList(list.id, next);
      onMessage("List renamed.");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not rename the list.");
    }
  }

  async function remove(list: MailingList) {
    if (!window.confirm(`Delete "${list.name}"? Emails already scheduled are not affected.`)) return;
    try {
      await deleteList(list.id);
      onMessage("List deleted.");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not delete the list.");
    }
  }

  return (
    <div className="grid items-start gap-7 xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900 sm:p-6">
        <h3 className="text-sm font-semibold">Create a list</h3>
        <p className="mt-1 text-sm text-slate-500 [.dark_&]:text-slate-400">
          Paste addresses or upload a CSV/TXT file. Duplicates and invalid addresses are removed.
        </p>

        <label htmlFor="list-name" className="mb-1.5 mt-5 block text-sm font-medium">
          List name
        </label>
        <input
          id="list-name"
          className={inputClass}
          placeholder="e.g. Newsletter subscribers"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label htmlFor="list-text" className="mb-1.5 mt-4 block text-sm font-medium">
          Recipients
        </label>
        <textarea
          id="list-text"
          rows={7}
          className={`${inputClass} resize-y font-mono text-xs leading-5`}
          placeholder="one@example.com, two@example.com"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 [.dark_&]:bg-emerald-400/10 [.dark_&]:text-emerald-300">
            {parsed.unique.length} valid
          </span>
          <span className="rounded-md bg-rose-50 px-2.5 py-1 font-medium text-rose-700 [.dark_&]:bg-rose-400/10 [.dark_&]:text-rose-300">
            {parsed.rejected} invalid
          </span>
          <label className={`${ghostButton} ml-auto cursor-pointer !py-1.5`}>
            <Icon name="upload" />
            Upload file
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        <button onClick={create} disabled={saving} className={`${primaryButton} mt-5 w-full`}>
          <Icon name="plus" />
          {saving ? "Saving..." : "Save list"}
        </button>
        <p className="mt-2 text-xs text-slate-500 [.dark_&]:text-slate-400">
          Maximum 500 recipients per list.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200/80 bg-white shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900">
        <div className="border-b border-slate-200/80 px-5 py-4 text-sm font-semibold [.dark_&]:border-slate-800 sm:px-6">
          Saved lists <span className="font-normal text-slate-500">({lists.length})</span>
        </div>

        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading...</div>
        ) : lists.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 [.dark_&]:bg-indigo-400/10 [.dark_&]:text-indigo-400 [.dark_&]:ring-indigo-400/20">
              <Icon name="list" className="h-5 w-5" />
            </div>
            <p className="font-medium">No saved lists yet</p>
            <p className="mt-1 text-sm text-slate-500 [.dark_&]:text-slate-400">
              Create one on the left, then load it from the Compose page.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 [.dark_&]:divide-slate-800">
            {lists.map((list) => (
              <li key={list.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
                <div className="min-w-0">
                  <p className="truncate font-medium">{list.name}</p>
                  <p className="text-xs text-slate-500 [.dark_&]:text-slate-400">
                    {list.recipients.length.toLocaleString()} recipients Â· updated {prettyDate(list.updatedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => rename(list)} className={`${ghostButton} !py-1.5`}>
                    <Icon name="pen" />
                    Rename
                  </button>
                  <button
                    onClick={() => remove(list)}
                    className={`${ghostButton} !py-1.5 !text-rose-600 [.dark_&]:!text-rose-300`}
                  >
                    <Icon name="trash" />
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
