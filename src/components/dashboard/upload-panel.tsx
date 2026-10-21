"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, ImageIcon, Loader2, X } from "lucide-react";
import { upload } from "@vercel/blob/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SHEET = /\.(csv|tsv|txt|xlsx|xls)$/i;
const PHOTO = /\.(jpe?g|png|webp|gif|avif|zip)$/i;
const MAX_SHEET = 25 * 1024 * 1024;
// On Vercel, function requests are capped at 4.5 MB: files go straight to Blob storage instead.
const DIRECT_UPLOAD = Boolean(process.env.NEXT_PUBLIC_VERCEL_ENV);

async function startImport(sheet: File, photos: File[]): Promise<Response> {
  if (!DIRECT_UPLOAD) {
    const form = new FormData();
    form.append("sheet", sheet);
    for (const p of photos) form.append("photos", p);
    return fetch("/api/imports", { method: "POST", body: form });
  }
  const send = async (f: File) => {
    const blob = await upload(`uploads/${f.name}`, f, { access: "private", handleUploadUrl: "/api/uploads", multipart: f.size > 20 * 1024 * 1024 });
    return { pathname: blob.pathname, name: f.name };
  };
  const [s, ...ps] = await Promise.all([send(sheet), ...photos.map(send)]);
  return fetch("/api/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheet: s, photos: ps }) });
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function UploadPanel({ onUploaded }: { onUploaded: (id: string) => void }) {
  const [sheet, setSheet] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[]) => {
    const list = [...files];
    const rejected = list.filter((f) => !SHEET.test(f.name) && !PHOTO.test(f.name));
    const sheets = list.filter((f) => SHEET.test(f.name));
    if (rejected.length) setError(`${rejected.map((f) => f.name).join(", ")}: not a CSV/XLSX sheet, photo or ZIP`);
    else setError(null);
    if (sheets.length > 1) setError("Drop one supplier sheet per import");
    if (sheets[0]) {
      if (sheets[0].size > MAX_SHEET) setError(`${sheets[0].name} is ${sizeLabel(sheets[0].size)}; the limit is 25 MB`);
      else setSheet(sheets[0]);
    }
    setPhotos((prev) => [...prev, ...list.filter((f) => PHOTO.test(f.name))]);
  };

  const submit = async () => {
    if (!sheet) {
      setError("Add a CSV or XLSX supplier sheet first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await startImport(sheet, photos);
      const body = (await res.json().catch(() => ({}))) as { id?: string; deduplicated?: boolean; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `Upload failed (${res.status})`);
      toast.success(body.deduplicated ? "This file is already being imported" : "Import started", { description: sheet.name });
      setSheet(null);
      setPhotos([]);
      onUploaded(body.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="upload-heading" className="rounded-xl surface-card p-5">
      <h2 id="upload-heading" className="text-base font-semibold">New import</h2>
      <p className="mt-1 text-sm text-slate">One supplier sheet (CSV or XLSX, up to 10,000 rows) and optional photos as files or a ZIP (up to 2,000).</p>
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "mt-4 grid min-h-32 cursor-pointer place-items-center rounded-md border border-dashed border-rule-strong px-4 py-6 text-center transition-colors",
          dragging ? "border-ink bg-secondary" : "hover:border-rule-strong hover:bg-row-hover",
        )}
      >
        <div>
          <p className="text-sm font-medium">Drop the sheet and photos here</p>
          <p className="mt-1 text-xs text-slate">or click to choose files</p>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept=".csv,.tsv,.txt,.xlsx,.xls,.jpg,.jpeg,.png,.webp,.gif,.avif,.zip"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {(sheet || photos.length > 0) && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {sheet && (
            <li className="flex items-center gap-2">
              <FileSpreadsheet className="size-4 text-ink" aria-hidden />
              <span className="truncate">{sheet.name}</span>
              <span className="text-xs text-slate">{sizeLabel(sheet.size)}</span>
              <button type="button" className="ml-auto rounded p-0.5 text-slate hover:text-ink" aria-label={`Remove ${sheet.name}`} onClick={() => setSheet(null)}>
                <X className="size-4" />
              </button>
            </li>
          )}
          {photos.length > 0 && (
            <li className="flex items-center gap-2">
              <ImageIcon className="size-4 text-ink" aria-hidden />
              <span>{photos.length === 1 ? photos[0].name : `${photos.length} photo files`}</span>
              <span className="text-xs text-slate">{sizeLabel(photos.reduce((n, p) => n + p.size, 0))}</span>
              <button type="button" className="ml-auto rounded p-0.5 text-slate hover:text-ink" aria-label="Remove photos" onClick={() => setPhotos([])}>
                <X className="size-4" />
              </button>
            </li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">
          {error}
        </p>
      )}
      <Button className="mt-4 w-full md:w-auto" onClick={submit} disabled={busy || !sheet}>
        {busy && <Loader2 className="animate-spin" aria-hidden />}
        {busy ? "Uploading" : "Start import"}
      </Button>
    </section>
  );
}
