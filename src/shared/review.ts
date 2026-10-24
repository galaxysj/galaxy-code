import type { FileDiff } from './types'

/** Images and binary assets do not belong in the code review. */
export function isReviewBinaryPath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|heic|heif|bmp|ico|icns|tiff?|svgz?|psd|ai|eps|pdf|zip|gz|bz2|xz|7z|rar|tar|dmg|iso|exe|dll|so|dylib|node|bin|pack|a|o|obj|class|jar|wasm|pyc|ttf|otf|woff2?|eot|mp[34]|m4[av]|mov|wav|ogg|flac|aac|webm|avi|mkv|sqlite3?|db|docx?|xlsx?|pptx?)$/i.test(path)
}

export function isReviewTextDiff(diff: FileDiff): boolean {
  return !isReviewBinaryPath(diff.path) && !diff.patch.includes('\0') && !/^(?:Binary files .* differ|GIT binary patch)/m.test(diff.patch)
}
