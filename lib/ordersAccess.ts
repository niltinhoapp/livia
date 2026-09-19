import { getEstablishment } from "@/lib/repo";

export async function ordersEnabledFor(establishmentId: string): Promise<boolean> {
  return Boolean((await getEstablishment(establishmentId))?.bot?.ordersEnabled);
}
