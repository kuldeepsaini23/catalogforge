"use client";

import { ImportCard, type ImportRow } from "./import-card";
import { PageBody, PageHeader } from "./page";
import { UploadPanel } from "./upload-panel";
import { useJson } from "./use-json";

const ACTIVE = new Set(["queued", "parsing", "building", "paused"]);

export function ImportsView() {
  const { data, error, refresh } = useJson<{ imports: ImportRow[] }>("/api/imports", 2000);
  const imports = data?.imports ?? [];
  const running = imports.filter((i) => ACTIVE.has(i.status)).length;
  return (
    <PageBody>
      <PageHeader
        title="Imports"
        description={running ? `${running} import${running === 1 ? "" : "s"} running in the background. You can leave this page.` : "Upload a supplier sheet to build catalog products."}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23.5rem]">
        <section aria-label="Recent imports" className="order-2 space-y-4 lg:order-1">
          {error && <p className="rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">Could not load imports: {error}</p>}
          {data && imports.length === 0 && (
            <div className="rounded-xl border border-dashed border-rule-strong px-6 py-12 text-center text-sm text-slate">
              No imports yet. Upload a sheet to start; the fixture generator writes samples to <code className="font-mono text-ink">fixtures/out/</code>.
            </div>
          )}
          {imports.map((imp) => (
            <ImportCard key={imp.id} imp={imp} onChanged={refresh} />
          ))}
        </section>
        <div className="order-1 lg:sticky lg:top-6 lg:order-2 lg:self-start">
          <UploadPanel onUploaded={refresh} />
        </div>
      </div>
    </PageBody>
  );
}
