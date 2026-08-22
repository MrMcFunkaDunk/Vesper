import { invoke } from "@tauri-apps/api/core";

export interface LoyaltyRequiredItem {
  type_id: number;
  type_name: string;
  quantity: number;
}

export interface LoyaltyStoreOffer {
  offer_id: number;
  type_id: number;
  type_name: string;
  quantity: number;
  isk_cost: number;
  lp_cost: number;
  required_items: LoyaltyRequiredItem[];
}

/** Every item purchasable with LP at one corporation's store - public ESI
 * data, no character context needed beyond knowing which corp to ask. */
export function getLoyaltyStoreOffers(corporationId: number): Promise<LoyaltyStoreOffer[]> {
  return invoke("get_loyalty_store_offers", { corporationId });
}
