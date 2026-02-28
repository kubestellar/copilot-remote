import { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Text } from '@primer/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', bg: 'canvas.default', flexDirection: 'column', gap: 3, p: 4 }}>
          <Text sx={{ fontSize: 4 }}>⚠️</Text>
          <Text sx={{ fontWeight: 'bold', fontSize: 2, color: 'fg.default' }}>Something went wrong</Text>
          <Text sx={{ color: 'fg.muted', fontSize: 1, textAlign: 'center', maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </Text>
          <button
            onClick={this.handleReset}
            style={{
              padding: '8px 20px', borderRadius: 6,
              background: '#238636', color: '#fff',
              border: 'none', cursor: 'pointer',
              fontWeight: 600, fontSize: 14,
            }}
          >
            Try again
          </button>
        </Box>
      );
    }

    return this.props.children;
  }
}
