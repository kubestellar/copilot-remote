import { memo } from 'react';
import { Box, Text } from '@primer/react';
import type { ChatMessage } from '../types';
import ReactMarkdown from 'react-markdown';

interface Props {
  message: ChatMessage;
}

export const MessageBubble = memo(function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        mb: 2,
        px: 2,
      }}
    >
      <Box
        sx={{
          maxWidth: '85%',
          p: 3,
          borderRadius: 2,
          bg: isUser
            ? 'accent.subtle'
            : isSystem
            ? 'attention.subtle'
            : 'canvas.subtle',
          border: '1px solid',
          borderColor: isUser
            ? 'accent.muted'
            : isSystem
            ? 'attention.muted'
            : 'border.default',
        }}
      >
        {!isUser && (
          <Text sx={{ fontSize: 0, color: 'fg.muted', mb: 1, display: 'block', fontWeight: 'bold' }}>
            {isSystem ? '⚙️ System' : '🤖 Copilot'}
          </Text>
        )}
        <Box sx={{ fontSize: 1, color: 'fg.default', '& p': { m: 0, mb: 2 }, '& p:last-child': { mb: 0 }, '& pre': { bg: 'canvas.inset', p: 2, borderRadius: 2, overflow: 'auto', fontSize: 0 }, '& code': { bg: 'canvas.inset', px: 1, borderRadius: 1, fontSize: '85%' } }}>
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </Box>
        <Text sx={{ fontSize: 0, color: 'fg.muted', mt: 1, display: 'block', textAlign: isUser ? 'right' : 'left' }}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </Text>
      </Box>
    </Box>
  );
});
