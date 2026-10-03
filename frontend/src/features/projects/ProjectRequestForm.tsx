import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderInput, Plus, X } from 'lucide-react';
import type { ProjectRootPickerResult } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateProjectRequest, validateProjectRoots, type ProjectRequest } from '@/validation';

interface ProjectRequestFormProps {
  onSubmit: (value: ProjectRequest) => Promise<boolean>;
  onPickRoots: (signal: AbortSignal) => Promise<ProjectRootPickerResult>;
  onCancel?: () => void;
}

export function ProjectRequestForm({ onSubmit, onPickRoots, onCancel }: ProjectRequestFormProps) {
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [manualPath, setManualPath] = useState('');
  const [errors, setErrors] = useState<Partial<Record<keyof ProjectRequest, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [pickerMessage, setPickerMessage] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const rootsRef = useRef<HTMLFieldSetElement>(null);
  const pickerRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pickerRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (errors.name) nameRef.current?.focus();
    else if (errors.roots) rootsRef.current?.focus();
  }, [errors]);

  async function selectFolders() {
    pickerRequest.current?.abort();
    const controller = new AbortController();
    pickerRequest.current = controller;
    setPicking(true);
    setPickerMessage('Choose the repository folders for this project.');
    try {
      const result = await onPickRoots(controller.signal);
      if (!mounted.current || controller.signal.aborted || pickerRequest.current !== controller) return;
      if (result.status === 'selected') {
        const selectedRoots = [...roots, ...result.roots.filter(root => !roots.includes(root))];
        setRoots(selectedRoots);
        const rootError = validateProjectRoots(selectedRoots);
        setErrors(current => ({ ...current, roots: rootError }));
        setPickerMessage(rootError ? 'Review the selected folder list before requesting approval.' : `${result.roots.length} folder${result.roots.length === 1 ? '' : 's'} added to this project draft.`);
      } else if (result.status === 'cancelled') {
        setPickerMessage('Folder selection was cancelled. Your project name and selected folders are unchanged.');
      } else if (result.status === 'unavailable') {
        setManualEntryOpen(true);
        setPickerMessage('The native folder picker is unavailable here. Add absolute folder paths manually below.');
      } else if (result.status === 'timeout') {
        setManualEntryOpen(true);
        setPickerMessage('Folder selection timed out. Your project draft is unchanged; try again or add paths manually.');
      } else {
        setManualEntryOpen(true);
        setPickerMessage('The native folder picker could not open. Your draft is unchanged; add paths manually or retry.');
      }
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setManualEntryOpen(true);
        setPickerMessage('The native folder picker could not open. Your draft is unchanged; add paths manually or retry.');
      }
    } finally {
      if (pickerRequest.current === controller) pickerRequest.current = null;
      if (mounted.current) setPicking(false);
    }
  }

  function addManualPath() {
    const path = manualPath;
    const nextRoots = [...roots, path];
    const rootError = validateProjectRoots(nextRoots);
    if (rootError) {
      setErrors(current => ({ ...current, roots: rootError }));
      return;
    }
    setRoots(nextRoots);
    setManualPath('');
    setErrors(current => ({ ...current, roots: undefined }));
    setPickerMessage('Folder added to this project draft.');
  }

  function removeRoot(index: number) {
    const nextRoots = roots.filter((_, rootIndex) => rootIndex !== index);
    setRoots(nextRoots);
    setErrors(current => ({ ...current, roots: validateProjectRoots(nextRoots) }));
    setPickerMessage('Folder removed from this project draft.');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateProjectRequest(name, roots);
    if (!validation.ok) {
      setErrors({ [validation.field]: validation.message });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      if (await onSubmit(validation.value)) {
        setName('');
        setRoots([]);
        setManualPath('');
        setPickerMessage('');
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-5" noValidate onSubmit={handleSubmit}>
      <div className="grid gap-2">
        <Label htmlFor="project-name">Project name</Label>
        <Input
          ref={nameRef}
          id="project-name"
          name="name"
          autoComplete="off"
          maxLength={100}
          required
          spellCheck
          placeholder="e.g. Checkout platform"
          value={name}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? 'project-name-error' : undefined}
          onChange={event => {
            setName(event.currentTarget.value);
            if (errors.name) setErrors(current => ({ ...current, name: undefined }));
          }}
        />
        {errors.name && <p id="project-name-error" className="field-error">{errors.name}</p>}
      </div>

      <fieldset ref={rootsRef} tabIndex={-1} className="grid min-w-0 gap-3 border-t border-border pt-4" aria-describedby={errors.roots ? 'project-roots-error' : 'project-roots-help'}>
        <legend className="px-1 text-sm font-semibold">Repository folders</legend>
        <p id="project-roots-help" className="text-sm leading-6 text-muted-foreground">Select only the folders you want this project to include. They may be in unrelated locations; OpenWorkspace will not grant access to a common parent.</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={picking || submitting} aria-busy={picking} onClick={() => void selectFolders()}>
            <FolderInput aria-hidden="true" data-icon="inline-start" />
            {picking ? 'Waiting for folder selection…' : 'Choose folders…'}
          </Button>
          <span className="text-xs text-muted-foreground">Native picker when available</span>
        </div>

        {pickerMessage && <p role="status" className="text-sm text-muted-foreground">{pickerMessage}</p>}

        {roots.length === 0 ? (
          <p className="border-y border-border py-3 text-sm text-muted-foreground">No folders selected yet. Choose folders or add their absolute paths manually.</p>
        ) : (
          <ul aria-label="Selected repository folders" className="divide-y divide-border border-y border-border">
            {roots.map((root, index) => (
              <li key={root} className="flex min-w-0 items-start justify-between gap-3 py-3">
                <span className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">{root}</span>
                <Button type="button" variant="ghost" size="icon-sm" disabled={submitting} aria-label={`Remove folder ${index + 1}`} onClick={() => removeRoot(index)}>
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <details
          className="border-t border-border pt-3"
          open={manualEntryOpen}
          onToggle={event => setManualEntryOpen(event.currentTarget.open)}
        >
          <summary className="min-h-9 cursor-pointer py-2 text-sm font-medium">Add folders manually</summary>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">Enter one absolute repository folder path at a time. The browser cannot turn a local file handle into a host path.</p>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="manual-root-path">Absolute repository folder path</Label>
              <Input
                id="manual-root-path"
                name="rootPath"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                maxLength={4096}
                spellCheck={false}
                placeholder="/Users/you/projects/storefront"
                value={manualPath}
                disabled={picking || submitting}
                aria-invalid={Boolean(errors.roots)}
                aria-describedby={errors.roots ? 'project-roots-error' : undefined}
                onChange={event => setManualPath(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addManualPath();
                  }
                }}
              />
            </div>
            <Button type="button" size="sm" variant="outline" disabled={picking || submitting || !manualPath} onClick={addManualPath}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add folder
            </Button>
          </div>
        </details>
        {errors.roots && <p id="project-roots-error" className="field-error" role="alert">{errors.roots}</p>}
      </fieldset>

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Review the exact folders above. Registration reads bounded metadata immediately. No project files are changed.</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onCancel && <Button type="button" variant="ghost" disabled={submitting || picking} onClick={onCancel}>Cancel</Button>}
          <Button type="submit" disabled={submitting || picking || roots.length === 0} className="shrink-0">
            {submitting ? 'Registering…' : 'Register project'}
          </Button>
        </div>
      </div>
    </form>
  );
}
