package httpapi

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/media"
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

func (s *Server) handleReorderCatalog(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input catalog.ReorderInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.catalog.Reorder(request.Context(), principal, membership, input); err != nil {
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

func (s *Server) handleDeleteCategory(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	version, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.catalog.DeleteCategory(request.Context(), principal, membership, request.PathValue("categoryID"), version); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
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

func (s *Server) handleDeleteProduct(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	version, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.catalog.DeleteProduct(request.Context(), principal, membership, request.PathValue("productID"), version); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
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
	imageKey, err := s.storeUploadedImage(response, request)
	if err != nil {
		writeProblem(response, request, err)
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
	if err := s.db.QueryRowContext(request.Context(), `SELECT count(*) FROM (
		SELECT image_key FROM products WHERE group_id=? AND image_key=? AND deleted_at IS NULL
		UNION ALL
		SELECT logo_key FROM groups WHERE id=? AND logo_key=?
	)`, membership.GroupID, request.PathValue("imageKey"), membership.GroupID, request.PathValue("imageKey")).Scan(&references); err != nil {
		writeProblem(response, request, err)
		return
	}
	if references == 0 {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	s.serveStoredImage(response, request, request.PathValue("imageKey"))
}

// storeUploadedImage parses one bounded multipart image, normalizes it, and
// stores its content-addressed PNG below the configured data directory. The
// response writer allows net/http to stop oversized request bodies early. It
// returns the image key or a client-safe validation error.
func (s *Server) storeUploadedImage(response http.ResponseWriter, request *http.Request) (string, error) {
	request.Body = http.MaxBytesReader(response, request.Body, 6<<20)
	if err := request.ParseMultipartForm(5 << 20); err != nil {
		return "", domain.ValidationError{Field: "image", Message: "must be multipart form data containing an image no larger than 5 MiB"}
	}
	if request.MultipartForm != nil {
		defer request.MultipartForm.RemoveAll()
	}
	file, _, err := request.FormFile("image")
	if err != nil {
		return "", domain.ValidationError{Field: "image", Message: "is required"}
	}
	defer file.Close()
	imageKey, _, err := media.NormalizeAndStoreImage(s.config.DataDirectory, file)
	if err != nil {
		return "", domain.ValidationError{Field: "image", Message: err.Error()}
	}
	return imageKey, nil
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

func requiredIfMatchVersion(request *http.Request) (int64, error) {
	value := request.Header.Get("If-Match")
	if len(value) < 4 || value[0] != '"' || value[len(value)-1] != '"' {
		return 0, fmt.Errorf("%w: If-Match is required", domain.ErrPrecondition)
	}
	value = value[1 : len(value)-1]
	value = strings.TrimPrefix(value, "v")
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 {
		return 0, fmt.Errorf("%w: If-Match must contain a valid version", domain.ErrPrecondition)
	}
	return version, nil
}
