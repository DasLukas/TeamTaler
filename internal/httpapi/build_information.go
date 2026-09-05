package httpapi

import "strings"

const (
	developmentVersion   = "dev"
	unknownBuildRevision = "unknown"
)

// BuildInformation identifies one immutable server and web-client build.
type BuildInformation struct {
	BuildID string `json:"buildId"`
}

// NewBuildInformation creates the identifier shared by the Go server and the
// compiled React client.
//
// Parameters:
//   - version: release version injected by the build pipeline.
//   - revision: source revision injected by the build pipeline.
//
// Returns normalized build information. Blank values use development-safe
// defaults. This function does not return an error.
//
// Example:
//
//	info := NewBuildInformation("1.2.0", "abc123")
func NewBuildInformation(version, revision string) BuildInformation {
	version = strings.TrimSpace(version)
	revision = strings.TrimSpace(revision)
	if version == "" {
		version = developmentVersion
	}
	if revision == "" {
		revision = unknownBuildRevision
	}
	return BuildInformation{BuildID: version + "@" + revision}
}

func (information BuildInformation) normalized() BuildInformation {
	if strings.TrimSpace(information.BuildID) == "" {
		return NewBuildInformation("", "")
	}
	information.BuildID = strings.TrimSpace(information.BuildID)
	return information
}
