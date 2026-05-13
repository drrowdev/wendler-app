import { redirect } from 'next/navigation';

export default function CardioPlanRedirect() {
  redirect('/program?tab=cardio');
}
