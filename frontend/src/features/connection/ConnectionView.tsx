import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { WorkbenchState } from '@/use-workbench';

export function ConnectionView({ state, onConnect }: {
  state: WorkbenchState;
  onConnect: () => void;
}) {
  const connecting = state.phase === 'connecting';

  return (
    <div className="connection-page min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#connection-main">Skip to connection</a>
      <header className="flex h-16 items-center justify-between border-b border-border px-5 sm:px-8">
        <a href="#overview" className="flex items-center gap-3 font-semibold tracking-tight text-foreground no-underline">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">OW</span>
          OpenWorkspace
        </a>
        <Badge variant="outline" className="gap-1.5 font-normal">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Local service
        </Badge>
      </header>
      <main id="connection-main" className="mx-auto grid max-w-5xl gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-16 lg:py-16">
        <section className="min-w-0" aria-labelledby="connection-heading">
          <p className="eyebrow">THIS BROWSER TAB</p>
          <h1 id="connection-heading" className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Connect to your local workspace</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
            By selecting Connect this browser, you allow this tab to view registered project metadata, register and remove projects, and run workspace operations. It can also show the local MCP client configuration.
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Connecting registers nothing by itself. Registering a project reads bounded metadata immediately; execution is authorized by your assistant client, and the dashboard only records what ran. This preview does not read secrets, install tools, or change project files.</p>
          <Button type="button" className="mt-6" disabled={connecting} aria-busy={connecting} onClick={onConnect}>
            {connecting ? 'Connecting…' : 'Connect this browser'}
            {!connecting && <ArrowRight aria-hidden="true" data-icon="inline-end" />}
          </Button>
          {connecting && <p role="status" className="mt-3 text-sm text-muted-foreground">Creating a temporary dashboard session…</p>}
          <p className="mt-4 text-xs leading-5 text-muted-foreground">The session belongs to this browser tab, expires after 12 hours, and ends when the local service restarts. Disconnect it at any time from Access &amp; privacy.</p>
        </section>
        <aside className="self-start border-t border-border pt-6 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0" aria-label="Local connection boundaries">
          <h2 className="text-sm font-semibold">Local, not a sandbox</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">The session connects this dashboard to the local OpenWorkspace service. It records activity; it does not gate what your assistant may do.</p>
          <p className="mt-5 text-xs leading-5 text-muted-foreground">A user with access to this machine can imitate local browser requests; this consent is not an operating-system access boundary.</p>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">Use the canonical local URL printed by OpenWorkspace. Dashboard consent accepts the 127.0.0.1 host, not the localhost alias.</p>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">Project metadata may be sensitive. Register only directories you intend to inspect and share with your assistant.</p>
        </aside>
      </main>
    </div>
  );
}
