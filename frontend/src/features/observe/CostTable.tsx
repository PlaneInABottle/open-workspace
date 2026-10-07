import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ObserverCostRow } from '@/api';
import { formatChanges, formatCost, formatTime, formatTokens, shortId } from '@/features/observe/observer-labels';

export function CostTable({ rows }: { rows: ObserverCostRow[] }) {
  if (rows.length === 0) {
    return <p role="status" className="py-5 text-sm text-muted-foreground">No cost data in this window. The session database may be unreadable.</p>;
  }
  const totalCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const anyCost = rows.some(row => row.cost !== null);
  const totalIn = rows.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0);
  const totalOut = rows.reduce((sum, row) => sum + (row.tokens?.output ?? 0), 0);
  return (
    <div>
      <p id="cost-table-scroll-hint" className="sr-only md:not-sr-only md:py-2 md:text-xs md:text-muted-foreground">This cost table scrolls horizontally at narrow widths.</p>
      <Table wrapperProps={{
        tabIndex: 0,
        role: 'region',
        'aria-label': 'Session cost table',
        'aria-describedby': 'cost-table-scroll-hint',
      }} className="min-w-[720px] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-[26%]">Session</TableHead>
            <TableHead scope="col" className="w-[12%]">Cost</TableHead>
            <TableHead scope="col" className="w-[24%]">Tokens sent / received</TableHead>
            <TableHead scope="col" className="w-[16%]">Changes</TableHead>
            <TableHead scope="col" className="w-[10%] whitespace-normal break-words">Messages (you/assistant)</TableHead>
            <TableHead scope="col" className="w-[12%]">Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.sessionID}>
              <TableCell className="whitespace-normal">
                <a className="font-mono text-xs underline-offset-4 hover:underline" href={`#observe/${row.sessionID}`}>{shortId(row.sessionID)}</a>
                {row.title && <p className="mt-0.5 break-words text-xs text-muted-foreground">{row.title}</p>}
              </TableCell>
              <TableCell className="font-mono text-xs">{formatCost(row.cost)}</TableCell>
              <TableCell className="whitespace-normal font-mono text-xs">{formatTokens(row.tokens)}</TableCell>
              <TableCell className="whitespace-normal font-mono text-xs">{formatChanges(row.additions, row.deletions, row.files)}</TableCell>
              <TableCell className="font-mono text-xs">{row.userTurns}/{row.assistantTurns}</TableCell>
              <TableCell className="whitespace-normal text-xs text-muted-foreground">{formatTime(row.last)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs text-muted-foreground">
        Across {rows.length} {rows.length === 1 ? 'session' : 'sessions'} in window · total {anyCost ? formatCost(totalCost) : '— (no recorded cost)'} · {totalIn.toLocaleString()} in / {totalOut.toLocaleString()} out.
      </p>
    </div>
  );
}
