import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import type { WorkbenchState } from '@/use-workbench';
import { formatSetupRequest } from './format-setup';

function OperatorCard({ state, onSave }: {
  state: WorkbenchState;
  onSave: (workspaceIds: string[]) => void;
}) {
  const granted = state.operatorScope?.workspaceIds ?? [];
  const [checked, setChecked] = useState<string[] | null>(null);
  const selection = checked ?? granted;
  const toggle = (id: string) => {
    setChecked(current => {
      const base = current ?? granted;
      return base.includes(id) ? base.filter(entry => entry !== id) : [...base, id];
    });
  };
  const dirty = checked !== null && [...checked].sort().join() !== [...granted].sort().join();
  return (
    <section className="max-w-4xl" aria-labelledby="operator-heading">
      <p className="eyebrow">02 / OPERATOR ACCESS</p>
      <h2 id="operator-heading" className="text-base font-semibold">Let your assistant operate</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
        Read-only by default. Grant once per workspace and your assistant can restart mapped services,
        run manifest tests and hold leases there — bounded, logged and visible below. Revoke anytime;
        revoking a project also removes it here.
      </p>
      {state.workspaces.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">Approve a project first, then choose where your assistant may operate.</p>
      )}
      {state.workspaces.length > 0 && (
        <form
          className="mt-4 grid max-w-2xl gap-2"
          onSubmit={event => {
            event.preventDefault();
            onSave(selection);
            setChecked(null);
          }}
        >
          {state.workspaces.map(workspace => (
            <label key={workspace.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selection.includes(workspace.id)}
                disabled={state.operatorLoading}
                onChange={() => toggle(workspace.id)}
              />
              <span className="font-medium">{workspace.name}</span>
              {granted.includes(workspace.id) && <Badge variant="outline">operator</Badge>}
            </label>
          ))}
          <div>
            <Button type="submit" variant="outline" size="sm" disabled={state.operatorLoading || !dirty}>
              {state.operatorLoading ? 'Saving…' : granted.length === 0 ? 'Grant operator access' : 'Update operator access'}
            </Button>
          </div>
        </form>
      )}
      {state.activity.length > 0 && (
        <div className="mt-6 max-w-3xl">
          <h3 className="text-sm font-semibold">Recent operations</h3>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {state.activity.slice().reverse().slice(0, 10).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-xs">
                <span className="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
                <Badge variant="outline">{entry.actor === 'dashboard' ? 'you' : 'assistant'}</Badge>
                <span className="font-mono">{entry.operation}</span>
                {entry.detail && <span className="break-all text-muted-foreground">{entry.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AiSetupView({ state, selectedId, onCopyText, onSaveOperator }: {
  state: WorkbenchState;
  selectedId: string | null;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
  onSaveOperator: (workspaceIds: string[]) => void;
}) {
  const [copying, setCopying] = useState(false);
  const material = formatSetupRequest(state.clientConfig, selectedId);

  async function copySetupRequest() {
    if (!material || copying) return;
    setCopying(true);
    try {
      await onCopyText(material.copyText, 'Copied the setup request. Review the proposed client configuration before applying it.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="max-w-5xl space-y-8">
      <header className="border-b border-border pb-5">
        <p className="eyebrow">KEEP YOUR EXISTING WORKFLOW</p>
        <h1 className="text-2xl font-semibold tracking-tight">Connect your AI</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Add the local MCP connection to your current assistant. Review every configuration change before applying it.</p>
      </header>

      <section className="max-w-4xl" aria-labelledby="setup-request-heading">
        <p className="eyebrow">01 / SETUP REQUEST</p>
        <h2 id="setup-request-heading" className="text-base font-semibold">Prepare the connection in your assistant</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">One message includes the generated local stdio entry and the right approved-workspace context. Ask your assistant to adapt it to the client you choose while preserving existing settings.</p>
        {material ? (
          <pre role="region" aria-label="Setup request preview" tabIndex={0} className="code-panel mt-4">{material.copyText}</pre>
        ) : (
          <p role="status" className="mt-4 text-sm text-muted-foreground">The local MCP entry is unavailable. Refresh the workspace and try again.</p>
        )}
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!material || copying} aria-busy={copying} onClick={() => void copySetupRequest()}>
          <Copy aria-hidden="true" data-icon="inline-start" />
          {copying ? 'Copying…' : 'Copy setup request'}
        </Button>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">Nothing is written automatically. Review and approve any client configuration change. The local state path in the generated entry is specific to this machine and should not be committed as a reusable team path.</p>
      </section>

      <Separator />

      <OperatorCard state={state} onSave={onSaveOperator} />

      {material && (
        <>
          <Separator />
          <details className="project-entry-disclosure max-w-4xl">
            <summary>
              <span>
                <span className="eyebrow">OPTIONAL</span>
                <span className="block text-sm font-semibold">Client-specific setup instructions</span>
                <span className="mt-1 block text-xs text-muted-foreground">Open only the guide for the assistant client you use.</span>
              </span>
              <span aria-hidden="true" className="disclosure-chevron">⌄</span>
            </summary>
            <div className="grid gap-3 border-t border-border py-4">
              {material.clientGuides.map(guide => (
                <details key={guide.id} className="border-b border-border pb-3">
                  <summary className="cursor-pointer py-2 text-sm font-medium">{guide.title}</summary>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.location}</p>
                  <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm leading-6 text-muted-foreground">
                    {guide.guidance.map(step => <li key={step}>{step}</li>)}
                  </ol>
                  <a className="mt-3 inline-flex min-h-9 items-center rounded-md text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" href={guide.sourceUrl} target="_blank" rel="noreferrer noopener">
                    Official setup documentation
                  </a>
                  <pre role="region" aria-label={`${guide.title} configuration example`} tabIndex={0} className="code-panel mt-4">{guide.configuration}</pre>
                </details>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
