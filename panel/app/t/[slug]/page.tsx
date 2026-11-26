import { redirect } from 'next/navigation';

export default async function InicioTenant({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/t/${slug}/parametros`);
}
