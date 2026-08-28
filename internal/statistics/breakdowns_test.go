package statistics

import (
	"fmt"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestBreakdownsUseStableCatalogIdentityAndAggregateTopSixPlusOther(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	const createdAt = "2026-08-10T10:00:00Z"
	for index := 1; index <= 7; index++ {
		categoryID := fmt.Sprintf("category-ranking-%d", index)
		productID := fmt.Sprintf("product-ranking-%d", index)
		bookingID := fmt.Sprintf("booking-ranking-%d", index)
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO categories(id,group_id,name,active,sort_order,version,created_at,updated_at,icon)
			VALUES(?,?,?,1,?,1,?,?,'food')`, categoryID, fixture.membership.GroupID, fmt.Sprintf("Category %d", index), index, createdAt, createdAt); err != nil {
			t.Fatalf("insert ranking category %d: %v", index, err)
		}
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,active,sort_order,version,created_at,updated_at)
			VALUES(?,?,?,?,100,1,?,1,?,?)`, productID, fixture.membership.GroupID, categoryID, fmt.Sprintf("Product %d", index), index, createdAt, createdAt); err != nil {
			t.Fatalf("insert ranking product %d: %v", index, err)
		}
		quantity := int64(index)
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO bookings(
			id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,
			quantity,unit_price_minor,total_minor,product_name,category_name,created_at,version
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, bookingID, fixture.membership.GroupID, fixture.periodID, categoryID, productID,
			fixture.membership.ID, members[(index-1)%len(members)], quantity, 100, quantity*100,
			fmt.Sprintf("Historic product %d", index), fmt.Sprintf("Historic category %d", index), createdAt); err != nil {
			t.Fatalf("insert ranking booking %d: %v", index, err)
		}
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO ledger_entries(
			id,group_id,period_id,membership_id,category_id,booking_id,account,amount_minor,description,created_at
		) VALUES(?,?,?,?,?,?,'MEMBER_RECEIVABLE',?,?,?)`, "ledger-ranking-"+fmt.Sprint(index), fixture.membership.GroupID,
			fixture.periodID, members[(index-1)%len(members)], categoryID, bookingID, quantity*100, bookingID, createdAt); err != nil {
			t.Fatalf("insert ranking ledger %d: %v", index, err)
		}
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE categories SET name='Renamed top category',version=version+1,updated_at='2026-08-11T00:00:00Z' WHERE id='category-ranking-7'`); err != nil {
		t.Fatalf("rename ranking category: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE products SET name='Renamed top product',version=version+1,updated_at='2026-08-11T00:00:00Z' WHERE id='product-ranking-7'`); err != nil {
		t.Fatalf("rename ranking product: %v", err)
	}
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewMemberStatistics, domain.PermissionViewGroupStatistics)
	query := Query{Preset: PresetCustom, From: "2026-08-10", To: "2026-08-10"}

	membersDashboard, err := fixture.service().Members(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read ranking member statistics: %v", err)
	}
	if len(membersDashboard.TopCategories.Items) != 7 || len(membersDashboard.TopProducts.Items) != 7 {
		t.Fatalf("member top-six-plus-other sizes=%d/%d", len(membersDashboard.TopCategories.Items), len(membersDashboard.TopProducts.Items))
	}
	if membersDashboard.TopCategories.Items[0].CategoryID != "category-ranking-7" || membersDashboard.TopCategories.Items[0].CategoryName != "Renamed top category" ||
		membersDashboard.TopProducts.Items[0].ProductID != "product-ranking-7" || membersDashboard.TopProducts.Items[0].ProductName != "Renamed top product" {
		t.Fatalf("renamed stable ranking identity categories=%#v products=%#v", membersDashboard.TopCategories.Items, membersDashboard.TopProducts.Items)
	}
	if !membersDashboard.TopCategories.Items[6].IsOther || membersDashboard.TopCategories.Items[6].ValidBookedUnits != 1 ||
		!membersDashboard.TopProducts.Items[6].IsOther || membersDashboard.TopProducts.Items[6].ValidBookedUnits != 1 {
		t.Fatalf("member other aggregation categories=%#v products=%#v", membersDashboard.TopCategories.Items, membersDashboard.TopProducts.Items)
	}

	financeDashboard, err := fixture.service().Finance(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read ranking finance statistics: %v", err)
	}
	if len(financeDashboard.Categories) != 7 || financeDashboard.Categories[0].CategoryID != "category-ranking-7" || financeDashboard.Categories[0].CategoryName != "Renamed top category" ||
		!financeDashboard.Categories[6].IsOther || financeDashboard.Categories[6].NetBookingChargesMinor != 100 {
		t.Fatalf("finance top-six-plus-other=%#v", financeDashboard.Categories)
	}
}
