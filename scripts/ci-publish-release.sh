#!/usr/bin/env bash
# FRIDAY - publish a GitHub release only after its assets are proven, draft first.
#
# The release is created as a DRAFT (a draft is not public and creates no tag),
# every uploaded asset's SHA-256 is compared with the file that was built, and
# only then is the draft published, which creates the tag at the exact built
# commit. Any failure deletes the draft, so a half release is never public and
# never left behind. Because the assets are checked before publishing, this
# keeps working when GitHub's immutable releases are switched on (assets are
# frozen at publish). FRIDAY Release and FRIDAY Test Build both publish here.
#
#   ci-publish-release.sh --tag v1.2.3.4 --target <sha> --title <text> \
#     --notes-file <file> [--prerelease] <asset>...
#
# Needs GH_TOKEN and GITHUB_REPOSITORY. Exit 0: published and verified.
# Exit 1: nothing was published (the draft, if any, is deleted).
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
tag="" target="" title="" notes="" prerelease=false
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    --notes-file) notes="$2"; shift 2 ;;
    --prerelease) prerelease=true; shift ;;
    --) shift; break ;;
    -*) echo "::error::unknown option $1"; exit 1 ;;
    *) break ;;
  esac
done
[ -n "$tag" ] && [ -n "$target" ] && [ -n "$title" ] && [ -f "$notes" ] \
  || { echo "::error::--tag, --target, --title and an existing --notes-file are required"; exit 1; }
[ $# -gt 0 ] || { echo "::error::no assets to publish"; exit 1; }
for asset in "$@"; do
  [ -f "$asset" ] || { echo "::error::asset $asset does not exist"; exit 1; }
done

# Optional assets: the build record travels with the release when the build wrote one beside the update manifest,
# so a workflow that lists only the installer files still publishes it. Listed by hand already: not added twice.
for asset in "$@"; do
  [ "$(basename "$asset")" = "friday-update.json" ] || continue
  for optional in friday-bundle.json; do
    candidate="$(dirname "$asset")/$optional"
    [ -f "$candidate" ] || continue
    listed=false
    for have in "$@"; do
      [ "$(basename "$have")" = "$optional" ] && listed=true
    done
    [ "$listed" = true ] || set -- "$@" "$candidate"
  done
  break
done

# GitHub refuses a release asset above 2 GiB: stop before anything is uploaded or a draft is created.
max_bytes=2147483648
for asset in "$@"; do
  size=$(wc -c < "$asset" | tr -d '[:space:]')
  [ "$size" -le "$max_bytes" ] \
    || { echo "::error::$(basename "$asset") is $size bytes, over the $max_bytes bytes GitHub accepts for one release asset - nothing was published."; exit 1; }
done

drafts() {
  gh api "repos/$repo/releases?per_page=100" \
    --jq ".[] | select(.draft and .tag_name == \"$tag\") | .id"
}

# A draft that a cancelled run left for this tag is removed first, so the new
# draft is the only one and nothing stale is ever published.
for stale in $(drafts); do
  echo "removing a draft left by an earlier run ($stale)"
  gh api -X DELETE "repos/$repo/releases/$stale" >/dev/null
done

create=(gh release create "$tag" --draft --target "$target" --title "$title" --notes-file "$notes")
[ "$prerelease" = true ] && create+=(--prerelease)
"${create[@]}" "$@" >/dev/null

id=$(drafts | head -n 1)
[ -n "$id" ] || { echo "::error::the draft release for $tag was not found after it was created"; exit 1; }

drop() {
  echo "::error::$1 - the draft is deleted and nothing was published."
  gh api -X DELETE "repos/$repo/releases/$id" >/dev/null 2>&1 || true
  exit 1
}

listing=$(gh api "repos/$repo/releases/$id/assets?per_page=100" \
  --jq '.[] | [.name, (.digest // ""), (.id | tostring)] | @tsv') || drop "the draft's assets could not be listed"

for asset in "$@"; do
  name=$(basename "$asset")
  # Read through stdin: for a file name that holds a backslash (a Windows path
  # in Git Bash) GNU sha256sum puts a backslash before the hash it prints.
  want="sha256:$(sha256sum < "$asset" | cut -d' ' -f1)"
  row=$(printf '%s\n' "$listing" | awk -F'\t' -v n="$name" '$1 == n { print; exit }')
  [ -n "$row" ] || drop "$name was not uploaded"
  digest=$(printf '%s' "$row" | cut -f2)
  if [ -z "$digest" ]; then
    # Older API answers carry no digest: read the uploaded bytes back instead.
    asset_id=$(printf '%s' "$row" | cut -f3)
    digest="sha256:$(gh api -H 'Accept: application/octet-stream' "repos/$repo/releases/assets/$asset_id" | sha256sum | cut -d' ' -f1)"
  fi
  [ "$digest" = "$want" ] || drop "$name on the draft ($digest) is not the built file ($want)"
  echo "verified $name ${want#sha256:}"
done

latest=true
[ "$prerelease" = true ] && latest=false
gh api -X PATCH "repos/$repo/releases/$id" -F draft=false -f make_latest="$latest" >/dev/null \
  || drop "the verified draft could not be published"
echo "published $tag ($# assets verified before it became public)"
