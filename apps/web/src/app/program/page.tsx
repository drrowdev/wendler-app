import { Suspense } from 'react';
import ProgramTabs from './ProgramTabs';

export default function ProgramPage() {
  return (
    <Suspense fallback={null}>
      <ProgramTabs />
    </Suspense>
  );
}
