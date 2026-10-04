import { Button } from '@/components/ui/button';
import type { Workspace } from '@/api';

export function PrivacyView({ workspaces, onRemove, busyIds, onDisconnect }: {
  workspaces: Workspace[];
  onRemove: (id: string) => void;
  busyIds: ReadonlySet<string>;
  onDisconnect: () => void;
}) {
  return (
    <div className="max-w-5xl space-y-9">
      <header className="border-b border-border pb-5">
        <p className="eyebrow">REGISTERED CONTEXT</p>
        <h1 className="text-2xl font-semibold tracking-tight">Projects &amp; privacy</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Registration is visible context, not permission. Execution is authorized by your assistant client. It is not an operating-system sandbox.</p>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="allowed-heading">
          <h2 id="allowed-heading" className="text-sm font-semibold">What registration records</h2>
          <ul className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground">
            <li>Read bounded repository and manifest metadata.</li>
            <li>List package script names, not their contents.</li>
            <li>Check optional executable availability without running tools.</li>
            <li>Keep project names and registered repository roots in local private state.</li>
          </ul>
        </section>
        <section aria-labelledby="not-allowed-heading">
          <h2 id="not-allowed-heading" className="text-sm font-semibold">Never, by design</h2>
          <ul className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground">
            <li>No <code>.env</code> files or secret contents are read.</li>
            <li>No installers or project-file changes by the service itself.</li>
            <li>Only bounded read-only database queries over a local socket; superuser roles and write statements are refused.</li>
            <li>No external API or application runtime connections, and no silent widening: roots are exactly the folders you chose.</li>
          </ul>
        </section>
      </div>

      <section aria-labelledby="registered-directories-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
           <h2 id="registered-directories-heading" className="text-sm font-semibold">Registered projects</h2>
           <span className="text-xs text-muted-foreground">Each listed root · discovery and bounded read-only queries only</span>
        </div>
        {workspaces.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No projects are registered in this browser session.</p>
        ) : (
          <ul className="divide-y divide-border">
            {workspaces.map(workspace => {
              const busy = busyIds.has(`workspace:${workspace.name}`);
              return (
               <li key={workspace.name} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{workspace.name}</h3>
                    <ul aria-label={`Registered repository folders for ${workspace.name}`} className="mt-2 grid gap-1">
                      {workspace.roots.map(root => <li key={root} className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-muted-foreground">{root}</li>)}
                    </ul>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRemove(workspace.name)} aria-label={`Remove project registration for ${workspace.name}`}>
                    {busy ? 'Removing…' : 'Remove project'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-t border-border pt-6" aria-labelledby="assistant-boundary-heading">
        <h2 id="assistant-boundary-heading" className="text-sm font-semibold">Your assistant remains independent</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">OpenWorkspace records what ran; it does not gate what your assistant may do through its shell or IDE. Repository metadata may itself be sensitive, and an external assistant may send results to its model provider. Register only directories you intend to review with that assistant.</p>
      </section>
      <Button type="button" variant="outline" onClick={onDisconnect}>Disconnect this browser tab</Button>
    </div>
  );
}
