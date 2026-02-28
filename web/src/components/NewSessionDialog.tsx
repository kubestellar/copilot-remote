import { useState, useCallback } from 'react';
import { Box, Text, TextInput, Button } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import { api } from '../lib/api';

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewSessionDialog({ onClose, onCreated }: Props) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [resumeId, setResumeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const session = await api.createSession({
        prompt: prompt.trim() || undefined,
        cwd: cwd.trim() || undefined,
        resume: resumeId.trim() || undefined,
      });
      onCreated(session.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }, [prompt, cwd, resumeId, onCreated]);

  return (
    <Box
      sx={{
        position: 'fixed', inset: 0, bg: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Box sx={{ bg: 'canvas.default', p: 4, borderRadius: 2, maxWidth: 480, width: '90%', border: '1px solid', borderColor: 'border.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
          <Text sx={{ fontWeight: 'bold', fontSize: 2, flex: 1, color: 'fg.default' }}>New Session</Text>
          <Button variant="invisible" onClick={onClose} leadingVisual={XIcon} aria-label="Close" />
        </Box>

        <Box sx={{ mb: 3 }}>
          <Text as="label" sx={{ display: 'block', mb: 1, fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>Prompt</Text>
          <TextInput
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should Copilot do?"
            sx={{ width: '100%' }}
            autoFocus
          />
        </Box>

        <Box sx={{ mb: 3 }}>
          <Text as="label" sx={{ display: 'block', mb: 1, fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>Working Directory</Text>
          <TextInput
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project (optional)"
            sx={{ width: '100%' }}
          />
        </Box>

        <Box sx={{ mb: 3 }}>
          <Text as="label" sx={{ display: 'block', mb: 1, fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>Resume Session ID</Text>
          <TextInput
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
            placeholder="Session ID to resume (optional)"
            sx={{ width: '100%' }}
          />
        </Box>

        {error && <Text sx={{ color: 'danger.fg', fontSize: 1, mb: 2, display: 'block' }}>{error}</Text>}

        <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <Button onClick={onClose} aria-label="Cancel">Cancel</Button>
          <Button variant="primary" onClick={handleCreate} disabled={creating} aria-label={creating ? 'Creating session' : 'Create Session'}>
            {creating ? 'Creating...' : 'Create Session'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
