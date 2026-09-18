"use client";
import { useEffect, useState } from "react";
import CampaignDetail from "./CampaignDetail";
import type { Campaign, CampaignRecipient } from "@/types";

export default function CampaignDetailPage({ params: _params }: { params: Promise<{ id: string }> }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { _params.then(({ id }) => fetch(`/api/campaigns/${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : Promise.reject()).then((b: { campaign: Campaign; recipients: CampaignRecipient[] }) => { setCampaign(b.campaign); setRecipients(b.recipients ?? []); }).catch(() => setCampaign(null)).finally(() => setLoaded(true))); }, [_params]);
  return <CampaignDetail campaign={loaded ? campaign : null} recipients={recipients} />;
}
