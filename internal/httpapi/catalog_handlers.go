package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func (s *Server) handleListCategories(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.catalog.List(request.Context(), membership.GroupID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, items)
}

func (s *Server) handleCreateCategory(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input catalog.CreateCategoryInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.catalog.CreateCategory(request.Context(), principal, membership, input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) handleUpdateCategory(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input catalog.UpdateCategoryInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := validateIfMatch(request, input.Version); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.catalog.UpdateCategory(request.Context(), principal, membership, request.PathValue("categoryID"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handleCreateProduct(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input catalog.CreateProductInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.catalog.CreateProduct(request.Context(), principal, membership, request.Header.Get("Idempotency-Key"), request.PathValue("categoryID"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusCreated, item)
}

func (s *Server) handleUpdateProduct(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input catalog.UpdateProductInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := validateIfMatch(request, input.Version); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.catalog.UpdateProduct(request.Context(), principal, membership, request.PathValue("productID"), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handleProductImage(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		writeProblem(response, request, domain.ErrForbidden)
		return
	}
	if _, err := s.catalog.ProductCategory(request.Context(), membership.GroupID, request.PathValue("productID")); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := request.ParseMultipartForm(5 << 20); err != nil {
		writeProblem(response, request, domain.ValidationError{Field: "image", Message: "must be multipart form data no larger than 5 MiB"})
		return
	}
	file, _, err := request.FormFile("image")
	if err != nil {
		writeProblem(response, request, domain.ValidationError{Field: "image", Message: "is required"})
		return
	}
	defer file.Close()
	imageKey, _, err := catalog.NormalizeAndStoreImage(s.config.DataDirectory, file)
	if err != nil {
		writeProblem(response, request, domain.ValidationError{Field: "image", Message: err.Error()})
		return
	}
	imageURL, _, err := s.catalog.SetProductImage(request.Context(), principal, membership, request.PathValue("productID"), imageKey)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"imageUrl": imageURL})
}

func (s *Server) handleImage(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var references int
	if err := s.db.QueryRowContext(request.Context(), `SELECT count(*) FROM products WHERE group_id=? AND image_key=?`, membership.GroupID, request.PathValue("imageKey")).Scan(&references); err != nil {
		writeProblem(response, request, err)
		return
	}
	if references == 0 {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	path, err := catalog.ResolveImage(s.config.DataDirectory, request.PathValue("imageKey"))
	if err != nil {
		http.NotFound(response, request)
		return
	}
	if _, err := os.Stat(path); err != nil {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Content-Type", "image/png")
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("ETag", `"`+strings.TrimSuffix(request.PathValue("imageKey"), ".png")+`"`)
	http.ServeFile(response, request, path)
}

func versionETag(version int64) string { return fmt.Sprintf(`"v%d"`, version) }

func validateIfMatch(request *http.Request, version int64) error {
	value := request.Header.Get("If-Match")
	if value == "" {
		return nil
	}
	value = strings.Trim(value, `"`)
	value = strings.TrimPrefix(value, "v")
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed != version {
		return domain.ErrPrecondition
	}
	return nil
}
