import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ObserverTreeNode } from '@/api';
import { messageEyebrow, messageEyebrowClass, shortId } from '@/features/observe/observer-labels';

function subSessionLabel(count: number): string {
  return `${count} ${count === 1 ? 'sub-session' : 'sub-sessions'}`;
}

function ChildRow({ node, onViewRecords }: {
  node: ObserverTreeNode;
  onViewRecords: (sessionID: string) => void;
}) {
  const short = shortId(node.sessionID);
  const detail = node.detail;
  // Degraded payloads (no detail) still render the id; a missing spawn link
  // is a missing note, never proof the child does not belong.
  const title = detail?.title ?? short;
  const agent = detail?.agent ?? node.link?.agent ?? null;
  const records = detail?.records ?? null;
  const hasMessages = detail?.hasMessages ?? null;
  const orphan = detail?.orphan ?? false;
  const description = node.link?.description?.slice(0, 80) ?? null;
  // Zero-record children predate sidecar recording when session_message holds
  // rows for them; with neither records nor messages they are truly empty.
  const zeroState = records === 0
    ? hasMessages === true
      ? '(before recording started)'
      : hasMessages === false
        ? '(empty session)'
        : null
    : null;
  const showSpawnNote = !description && !orphan && zeroState === null;
  // The spawn description is the parent's briefing note for this subagent,
  // so it carries a briefing eyebrow in its own block (never inline where
  // the surrounding metadata could obscure it).
  const briefingEyebrow = description ? messageEyebrow('briefing', agent) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className="shrink-0 font-mono text-xs text-muted-foreground">↳</span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs sm:text-[0.8rem]">
          <span className="font-mono">{short}</span>
          {title !== short && <span className="font-medium"> · {title}</span>}
          {agent && <span className="text-muted-foreground"> [{agent}]</span>}
          {records !== null && zeroState === null && <span className="text-muted-foreground"> · {records} {records === 1 ? 'record' : 'records'}</span>}
          {zeroState !== null && <span className="text-muted-foreground"> · {zeroState}</span>}
          {showSpawnNote && <span className="text-muted-foreground"> · no spawn note</span>}
          {orphan && <span className="font-medium"> · orphaned — no parent link</span>}
        </p>
        {description && (
          <div className="mt-0.5">
            {briefingEyebrow && <p className={messageEyebrowClass}>{briefingEyebrow}</p>}
            <p className="break-words text-xs text-muted-foreground">{description}</p>
          </div>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => onViewRecords(node.sessionID)}>
        View records
      </Button>
    </div>
  );
}

function TreeNodeView({ node, depth, onViewRecords }: {
  node: ObserverTreeNode;
  depth: number;
  onViewRecords: (sessionID: string) => void;
}) {
  // Sub-sessions start collapsed so the parent's own records stay visible
  // without scrolling past a long child list; deeper levels keep their
  // expanded shape once the parent is opened.
  const [collapsed, setCollapsed] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
  const deep = depth >= 2;
  if (depth > 0) {
    return (
      <li className="border-l border-border py-1 pl-4">
        <ChildRow node={node} onViewRecords={onViewRecords} />
        {hasChildren && !deep && (
          <ul className="mt-1 grid gap-1">
            {node.children.map(child => <TreeNodeView key={child.sessionID} node={child} depth={depth + 1} onViewRecords={onViewRecords} />)}
          </ul>
        )}
        {hasChildren && deep && <p className="mt-1 font-mono text-xs text-muted-foreground">…</p>}
      </li>
    );
  }
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 break-words font-mono text-xs sm:text-[0.8rem]">
          session <span className="font-semibold">{shortId(node.sessionID)}</span>
        </p>
        {hasChildren && !deep && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} sub-sessions of ${shortId(node.sessionID)}`}
            onClick={() => setCollapsed(current => !current)}
          >
            {collapsed ? `${subSessionLabel(node.children.length)} ▼` : `Hide sub-sessions ▲`}
          </Button>
        )}
      </div>
      {hasChildren && !collapsed && !deep && (
        <ul className="mt-1 grid gap-1">
          {node.children.map(child => <TreeNodeView key={child.sessionID} node={child} depth={depth + 1} onViewRecords={onViewRecords} />)}
        </ul>
      )}
      {hasChildren && deep && <p className="mt-1 font-mono text-xs text-muted-foreground">…</p>}
    </li>
  );
}

export function SessionTree({ tree, onViewRecords }: {
  tree: ObserverTreeNode;
  onViewRecords: (sessionID: string) => void;
}) {
  return (
    <ul className="grid gap-1">
      <TreeNodeView node={tree} depth={0} onViewRecords={onViewRecords} />
    </ul>
  );
}
