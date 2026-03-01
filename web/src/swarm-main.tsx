import ReactDOM from 'react-dom/client';
import { ThemeProvider, BaseStyles } from '@primer/react';
import SwarmApp from './SwarmApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider colorMode="night" nightScheme="dark_dimmed">
    <BaseStyles>
      <SwarmApp />
    </BaseStyles>
  </ThemeProvider>,
);
