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
	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO categories(id,group_id,name,active,sort_order,version,created_at,updated_at,icon)
		VALUES('category-protected-only',?,'Protected only',1,8,1,?,?,'other')`, fixture.membership.GroupID, createdAt, createdAt); err != nil {
		t.Fatalf("insert protected-only category: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,active,sort_order,version,created_at,updated_at)
		VALUES('product-protected-only',?,'category-protected-only','Protected only',100,1,8,1,?,?)`, fixture.membership.GroupID, createdAt, createdAt); err != nil {
		t.Fatalf("insert protected-only product: %v", err)
	}
	for _, booking := range []struct {
		id, categoryID, productID string
		quantity                  int64
	}{
		{id: "booking-protected-ranking", categoryID: "category-ranking-1", productID: "product-ranking-1", quantity: 99},
		{id: "booking-protected-only", categoryID: "category-protected-only", productID: "product-protected-only", quantity: 98},
	} {
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO bookings(
			id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,
			quantity,unit_price_minor,total_minor,product_name,category_name,created_at,version
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, booking.id, fixture.membership.GroupID, fixture.periodID, booking.categoryID, booking.productID,
			fixture.membership.ID, members[0], booking.quantity, 100, booking.quantity*100, booking.productID, booking.categoryID, "2026-08-11T10:00:00Z"); err != nil {
			t.Fatalf("insert protected ranking booking %s: %v", booking.id, err)
		}
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE categories SET name='Renamed top category',version=version+1,updated_at='2026-08-11T00:00:00Z' WHERE id='category-ranking-7'`); err != nil {
		t.Fatalf("rename ranking category: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE products SET name='Renamed top product',version=version+1,updated_at='2026-08-11T00:00:00Z' WHERE id='product-ranking-7'`); err != nil {
		t.Fatalf("rename ranking product: %v", err)
	}
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)
	query := Query{Preset: PresetCustom, From: "2026-08-10", To: "2026-08-11"}

	dashboard, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read ranking statistics: %v", err)
	}
	membersDashboard := dashboard.Members
	if len(membersDashboard.TopCategories.Items) != 7 || len(membersDashboard.TopProducts.Items) != 7 {
		t.Fatalf("member top-six-plus-other sizes=%d/%d", len(membersDashboard.TopCategories.Items), len(membersDashboard.TopProducts.Items))
	}
	if !dashboard.Meta.PrivacyThresholdApplied {
		t.Fatalf("protected ranking bucket was not reflected in metadata: %#v", dashboard.Meta)
	}
	if membersDashboard.TopCategories.Items[0].CategoryID != "category-ranking-7" || membersDashboard.TopCategories.Items[0].CategoryName != "Renamed top category" ||
		membersDashboard.TopProducts.Items[0].ProductID != "product-ranking-7" || membersDashboard.TopProducts.Items[0].ProductName != "Renamed top product" {
		t.Fatalf("renamed stable ranking identity categories=%#v products=%#v", membersDashboard.TopCategories.Items, membersDashboard.TopProducts.Items)
	}
	if !membersDashboard.TopCategories.Items[6].IsOther || membersDashboard.TopCategories.Items[6].ValidBookedUnits != 1 ||
		!membersDashboard.TopProducts.Items[6].IsOther || membersDashboard.TopProducts.Items[6].ValidBookedUnits != 1 {
		t.Fatalf("member other aggregation categories=%#v products=%#v", membersDashboard.TopCategories.Items, membersDashboard.TopProducts.Items)
	}
	for _, item := range membersDashboard.TopCategories.Items {
		if item.CategoryID == "category-protected-only" {
			t.Fatalf("protected-only category influenced visible ranking: %#v", item)
		}
		if len(item.Series) != 2 || item.Series[0].ValidBookedUnits == nil || *item.Series[0].ValidBookedUnits != item.ValidBookedUnits || item.Series[0].PrivacySuppressed ||
			item.Series[1].ValidBookedUnits != nil || !item.Series[1].PrivacySuppressed {
			t.Fatalf("category series does not reconcile with ranking: %#v", item)
		}
	}
	for _, item := range membersDashboard.TopProducts.Items {
		if item.ProductID == "product-protected-only" {
			t.Fatalf("protected-only product influenced visible ranking: %#v", item)
		}
		if len(item.Series) != 2 || item.Series[0].ValidBookedUnits == nil || *item.Series[0].ValidBookedUnits != item.ValidBookedUnits || item.Series[0].PrivacySuppressed ||
			item.Series[1].ValidBookedUnits != nil || !item.Series[1].PrivacySuppressed {
			t.Fatalf("product series does not reconcile with ranking: %#v", item)
		}
	}
	fixture.grant(t, domain.PermissionViewAllBookingActivity)
	bypassed, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read ranking privacy bypass: %v", err)
	}
	if bypassed.Meta.PrivacyThresholdApplied || bypassed.Members.TopCategories.Items[0].CategoryID != "category-ranking-1" ||
		bypassed.Members.TopCategories.Items[0].ValidBookedUnits != 100 || bypassed.Members.TopProducts.Items[0].ProductID != "product-ranking-1" ||
		bypassed.Members.TopProducts.Items[0].ValidBookedUnits != 100 {
		t.Fatalf("full-activity bypass did not restore protected ranking values: %#v", bypassed.Members)
	}
	for _, point := range []MemberBreakdownPoint{
		bypassed.Members.TopCategories.Items[0].Series[1], bypassed.Members.TopProducts.Items[0].Series[1],
	} {
		if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != 99 {
			t.Fatalf("full-activity bypass point=%#v, want visible 99", point)
		}
	}

	financeDashboard := dashboard.Finance
	if len(financeDashboard.Categories) != 7 || financeDashboard.Categories[0].CategoryID != "category-ranking-7" || financeDashboard.Categories[0].CategoryName != "Renamed top category" ||
		!financeDashboard.Categories[6].IsOther || financeDashboard.Categories[6].NetBookingChargesMinor != 100 {
		t.Fatalf("finance top-six-plus-other=%#v", financeDashboard.Categories)
	}
}

func TestBreakdownSeriesFollowAdaptiveBucketsAndFillMissingValues(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	fixture.insertBooking(t, "booking-series-first", members[0], "2026-08-10T10:00:00Z", "", 2)
	fixture.insertBooking(t, "booking-series-last-one", members[1], "2026-08-12T10:00:00Z", "", 3)
	fixture.insertBooking(t, "booking-series-last-two", members[2], "2026-08-12T11:00:00Z", "", 1)
	fixture.insertBooking(t, "booking-series-visible-one", members[0], "2026-08-13T09:00:00Z", "", 1)
	fixture.insertBooking(t, "booking-series-visible-two", members[1], "2026-08-13T10:00:00Z", "", 2)
	fixture.insertBooking(t, "booking-series-visible-three", members[2], "2026-08-13T11:00:00Z", "", 3)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)

	dashboard, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-10", To: "2026-08-13",
	})
	if err != nil {
		t.Fatalf("read bucketed breakdown statistics: %v", err)
	}
	if dashboard.Meta.Bucket != BucketDay || len(dashboard.Members.Activity) != 4 {
		t.Fatalf("adaptive bucket metadata=%#v activity=%#v", dashboard.Meta, dashboard.Members.Activity)
	}
	if len(dashboard.Members.TopCategories.Items) != 1 || len(dashboard.Members.TopProducts.Items) != 1 {
		t.Fatalf("bucketed rankings=%#v/%#v", dashboard.Members.TopCategories, dashboard.Members.TopProducts)
	}
	category := dashboard.Members.TopCategories.Items[0]
	product := dashboard.Members.TopProducts.Items[0]
	wantUnits := []int64{2, 0, 4, 6}
	if category.ValidBookedUnits != 6 || product.ValidBookedUnits != 6 || len(category.Series) != len(wantUnits) || len(product.Series) != len(wantUnits) {
		t.Fatalf("bucketed ranking totals category=%#v product=%#v", category, product)
	}
	if !dashboard.Meta.PrivacyThresholdApplied {
		t.Fatalf("bucket privacy was not reflected in metadata: %#v", dashboard.Meta)
	}
	for index := range category.Series {
		if category.Series[index].PeriodStart != dashboard.Members.Activity[index].PeriodStart ||
			product.Series[index].PeriodStart != dashboard.Members.Activity[index].PeriodStart {
			t.Fatalf("bucket %d category=%#v product=%#v activity=%#v", index, category.Series[index], product.Series[index], dashboard.Members.Activity[index])
		}
	}
	for _, point := range []MemberBreakdownPoint{category.Series[0], product.Series[0], category.Series[2], product.Series[2]} {
		if !point.PrivacySuppressed || point.ValidBookedUnits != nil {
			t.Fatalf("one- or two-contributor bucket was exposed: %#v", point)
		}
	}
	for _, point := range []MemberBreakdownPoint{category.Series[1], product.Series[1]} {
		if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != 0 {
			t.Fatalf("zero-contributor bucket was not represented as a real zero: %#v", point)
		}
	}
	for _, point := range []MemberBreakdownPoint{category.Series[3], product.Series[3]} {
		if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != 6 {
			t.Fatalf("three-contributor bucket was not visible: %#v", point)
		}
	}

	fixture.grant(t, domain.PermissionViewAllBookingActivity)
	bypassed, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-10", To: "2026-08-13",
	})
	if err != nil {
		t.Fatalf("read bucketed breakdown bypass: %v", err)
	}
	if bypassed.Meta.PrivacyThresholdApplied {
		t.Fatalf("privacy metadata remained set for bypass: %#v", bypassed.Meta)
	}
	for _, item := range []MemberCategoryItem{bypassed.Members.TopCategories.Items[0]} {
		for index, want := range wantUnits {
			point := item.Series[index]
			if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != want {
				t.Fatalf("category bypass bucket %d=%#v want=%d", index, point, want)
			}
		}
	}
	for _, item := range []MemberProductItem{bypassed.Members.TopProducts.Items[0]} {
		for index, want := range wantUnits {
			point := item.Series[index]
			if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != want {
				t.Fatalf("product bypass bucket %d=%#v want=%d", index, point, want)
			}
		}
	}
}

func TestBreakdownSeriesExposeThreeContributorsAndMarkPartialBucket(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	fixture.insertBooking(t, "booking-partial-one", members[0], "2026-09-15T07:00:00Z", "", 1)
	fixture.insertBooking(t, "booking-partial-two", members[1], "2026-09-15T08:00:00Z", "", 2)
	fixture.insertBooking(t, "booking-partial-three", members[2], "2026-09-15T09:00:00Z", "", 3)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)

	dashboard, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-09-15", To: "2026-12-31",
	})
	if err != nil {
		t.Fatalf("read current partial bucket statistics: %v", err)
	}
	if dashboard.Meta.PrivacyThresholdApplied {
		t.Fatalf("three-contributor bucket was privacy-suppressed: %#v", dashboard.Meta)
	}
	categoryPoint := dashboard.Members.TopCategories.Items[0].Series[0]
	productPoint := dashboard.Members.TopProducts.Items[0].Series[0]
	for _, point := range []MemberBreakdownPoint{categoryPoint, productPoint} {
		if point.PrivacySuppressed || point.ValidBookedUnits == nil || *point.ValidBookedUnits != 6 || !point.IsPartial {
			t.Fatalf("three-contributor partial bucket=%#v", point)
		}
	}
}
