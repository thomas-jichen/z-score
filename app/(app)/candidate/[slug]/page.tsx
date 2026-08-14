import { CandidateDetail } from "@/components/CandidateDetail";

/**
 * Dynamic, not prerendered.
 *
 * Enriched candidates live in the signed-in profile's document, which is read
 * client-side, so which slugs exist is not knowable at build time. The fixture
 * slugs still resolve — CandidateDetail falls back to them.
 */
export default async function CandidatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CandidateDetail slug={slug} />;
}
