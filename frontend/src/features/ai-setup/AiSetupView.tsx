import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import type { WorkbenchState } from '@/use-workbench';
import { formatSetupRequest } from './format-setup';

function ActivityTrail({ state }: {
  state: WorkbenchState;
}) {
  if (!state.activity.length) return null;
  return (
    <section className="max-w-4xl" aria-labelledby="activity-heading">
      <p className="eyebrow">02 / RECENT OPERATIONS</p>
      <h2 id="activity-heading" className="text-base font-semibold">What ran here</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
        Every mutation is recorded with its actor, whether it came from this dashboard or your assistant.
        Execution itself is authorized by your assistant client.
      </p>
      <div className="mt-4 max-w-3xl">
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
    </section>
  );
}

export function AiSetupView({ state, selectedId, onCopyText }: {
  state: WorkbenchState;
  selectedId: string | null;
  onCopyText: (text: string, successMessage: string) => Promise<boolean>;
}) {
  const [copying, setCopying] = useState(false);
  const material = formatSetupRequest(state.clientConfig, selectedId);

  async function copySetupPrompt() {
    if (!material || copying) return;
    setCopying(true);
    try {
      await onCopyText(material.copyText, 'Copied the setup prompt. Paste it to your assistant; the dashboard records what ran.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="max-w-5xl space-y-8">
      <header className="border-b border-border pb-5">
        <p className="eyebrow">KEEP YOUR EXISTING WORKFLOW</p>
        <h1 className="text-2xl font-semibold tracking-tight">Connect your AI</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Paste one prompt to your assistant and your agent installs it.</p>
      </header>

      <section className="max-w-4xl" aria-labelledby="setup-prompt-heading">
        <p className="eyebrow">01 / SETUP PROMPT</p>
        <h2 id="setup-prompt-heading" className="text-base font-semibold">Let your agent install the connection</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">One prompt carries the generated local stdio entry, the registered-workspace context, and the install/verify instructions. Your agent adapts it to the client you use while preserving existing settings. Already connected? Paste the new prompt — your agent re-merges the entry, adds the AGENTS.md note, and re-verifies with workspace_list.</p>
        {material ? (
          <pre role="region" aria-label="Setup prompt preview" tabIndex={0} className="code-panel mt-4">{material.copyText}</pre>
        ) : (
          <p role="status" className="mt-4 text-sm text-muted-foreground">The local MCP entry is unavailable. Refresh the workspace and try again.</p>
        )}
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!material || copying} aria-busy={copying} onClick={() => void copySetupPrompt()}>
          <Copy aria-hidden="true" data-icon="inline-start" />
          {copying ? 'Copying…' : 'Copy setup prompt'}
        </Button>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">The local state path in the generated entry is specific to this machine and should not be committed as a reusable team path.</p>
      </section>

      <Separator />

      <ActivityTrail state={state} />
    </div>
  );
}
