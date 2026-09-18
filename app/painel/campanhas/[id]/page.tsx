import CampaignDetail from "./CampaignDetail";

export default function CampaignDetailPage({ params: _params }: { params: Promise<{ id: string }> }) {
  return <CampaignDetail campaign={null} recipients={[]} />;
}
