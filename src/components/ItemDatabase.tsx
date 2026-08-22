import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import {
  getItemCategories,
  getCategoryGroups,
  getGroupItems,
  getItemDetail,
  getItemDescription,
  type CategorySummary,
  type GroupSummary,
  type TypeSummary,
  type ItemDetail,
} from "../lib/market";
import { CATEGORY_ICON_BY_ICON_ID } from "./MarketBrowser";
import { typeIconUrl } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";

const SHIP_CATEGORY_ID = 6;

type View =
  | { level: "categories" }
  | { level: "groups"; categoryId: number; categoryName: string }
  | { level: "items"; categoryId: number; categoryName: string; groupId: number; groupName: string }
  | { level: "detail"; typeId: number; from: View };

interface ItemDatabaseProps {
  onSelectShip: (shipTypeId: number) => void;
}

function ItemDatabase({ onSelectShip }: ItemDatabaseProps) {
  const reportError = useErrorReporter();
  const [view, setView] = useState<View>({ level: "categories" });
  const [categories, setCategories] = useState<CategorySummary[] | null>(null);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [items, setItems] = useState<TypeSummary[] | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [description, setDescription] = useState<string | null>(null);

  useEffect(() => {
    getItemCategories()
      .then(setCategories)
      .catch((err) => reportError(`Failed to load item categories: ${err}`));
  }, [reportError]);

  useEffect(() => {
    if (view.level !== "groups") return;
    let cancelled = false;
    setGroups(null);
    getCategoryGroups(view.categoryId)
      .then((g) => {
        if (!cancelled) setGroups(g);
      })
      .catch((err) => reportError(`Failed to load groups: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [view, reportError]);

  useEffect(() => {
    if (view.level !== "items") return;
    let cancelled = false;
    setItems(null);
    getGroupItems(view.groupId)
      .then((i) => {
        if (!cancelled) setItems(i);
      })
      .catch((err) => reportError(`Failed to load items: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [view, reportError]);

  useEffect(() => {
    if (view.level !== "detail") return;
    let cancelled = false;
    setDetail(null);
    setDescription(null);
    getItemDetail(view.typeId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => reportError(`Failed to load item detail: ${err}`));
    getItemDescription(view.typeId)
      .then((d) => {
        if (!cancelled) setDescription(d);
      })
      .catch(() => {
        if (!cancelled) setDescription("");
      });
    return () => {
      cancelled = true;
    };
  }, [view, reportError]);

  function goBack() {
    if (view.level === "groups") setView({ level: "categories" });
    else if (view.level === "items") setView({ level: "groups", categoryId: view.categoryId, categoryName: view.categoryName });
    else if (view.level === "detail") setView(view.from);
  }

  return (
    <div className="item-db-page">
      {view.level !== "categories" && (
        <button type="button" className="detail-back" onClick={goBack}>
          <ChevronLeft size={16} strokeWidth={2} /> Back
        </button>
      )}

      {view.level === "categories" && (
        <>
          <p className="item-db-breadcrumb">Item Database</p>
          {categories === null ? (
            <p className="detail-empty">Loading categories...</p>
          ) : (
            <div className="item-db-grid">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="item-db-card"
                  onClick={() => setView({ level: "groups", categoryId: c.id, categoryName: c.name })}
                >
                  {c.icon_id != null && CATEGORY_ICON_BY_ICON_ID[c.icon_id] && (
                    <img src={CATEGORY_ICON_BY_ICON_ID[c.icon_id]} alt="" className="item-db-card-icon" />
                  )}
                  <span className="item-db-card-name">{c.name}</span>
                  <span className="data-table-tag data-table-tag-neutral">{c.item_count}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view.level === "groups" && (
        <>
          <p className="item-db-breadcrumb">Item Database / {view.categoryName}</p>
          {groups === null ? (
            <p className="detail-empty">Loading groups...</p>
          ) : (
            <div className="item-db-grid">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="item-db-card"
                  onClick={() =>
                    setView({ level: "items", categoryId: view.categoryId, categoryName: view.categoryName, groupId: g.id, groupName: g.name })
                  }
                >
                  <span className="item-db-card-name">{g.name}</span>
                  <span className="data-table-tag data-table-tag-neutral">{g.item_count}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view.level === "items" && (
        <>
          <p className="item-db-breadcrumb">
            Item Database / {view.categoryName} / {view.groupName}
          </p>
          {items === null ? (
            <p className="detail-empty">Loading items...</p>
          ) : (
            <div className="item-db-item-grid">
              {items.map((i) => (
                <button key={i.id} type="button" className="item-db-item" title={i.name} onClick={() => setView({ level: "detail", typeId: i.id, from: view })}>
                  <img src={typeIconUrl(i.id, 64, i.name)} alt="" className="item-db-item-icon" loading="lazy" />
                  <span className="item-db-item-name">{i.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view.level === "detail" && (
        <>
          {detail === null ? (
            <p className="detail-empty">Loading item...</p>
          ) : (
            <div className="item-db-detail">
              <div className="item-db-detail-header">
                <img src={typeIconUrl(detail.type_id, 64, detail.name)} alt="" className="item-db-detail-icon" />
                <div>
                  <p className="item-db-breadcrumb">
                    Item Database / {detail.category_name} / {detail.group_name}
                  </p>
                  <h2>{detail.name}</h2>
                </div>
                {detail.category_id === SHIP_CATEGORY_ID && (
                  <button
                    type="button"
                    className="kills-sync-btn item-db-fit-button"
                    onClick={() => onSelectShip(detail.type_id)}
                  >
                    Fit This Ship
                  </button>
                )}
              </div>

              {description && <p className="item-db-description">{description}</p>}

              {detail.attributes.length > 0 && (
                <div className="item-db-attributes">
                  {detail.attributes.map((a) => (
                    <div key={a.attribute_id} className="item-db-attribute-row">
                      <span className="item-db-attribute-name">{a.name}</span>
                      <span className="item-db-attribute-value">{a.value.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ItemDatabase;
