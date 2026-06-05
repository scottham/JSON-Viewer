import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4 else {
  fputs("Usage: swift scripts/make-gif.swift <frames-dir> <out.gif> <delaySeconds>\n", stderr)
  exit(1)
}

let framesDir = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let delay = Double(args[3]) ?? 0.18
let fm = FileManager.default

let frames = (try fm.contentsOfDirectory(at: framesDir, includingPropertiesForKeys: nil))
  .filter { $0.pathExtension.lowercased() == "png" }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }

guard !frames.isEmpty else {
  fputs("No PNG frames found in \(framesDir.path)\n", stderr)
  exit(1)
}

if fm.fileExists(atPath: outURL.path) {
  try fm.removeItem(at: outURL)
}

let gifType: CFString
if #available(macOS 11.0, *) {
  gifType = UTType.gif.identifier as CFString
} else {
  gifType = "com.compuserve.gif" as CFString
}

guard let destination = CGImageDestinationCreateWithURL(
  outURL as CFURL,
  gifType,
  frames.count,
  nil
) else {
  fputs("Unable to create GIF destination\n", stderr)
  exit(1)
}

let gifProperties: NSDictionary = [
  kCGImagePropertyGIFDictionary: [
    kCGImagePropertyGIFLoopCount: 0
  ]
]
let frameProperties: NSDictionary = [
  kCGImagePropertyGIFDictionary: [
    kCGImagePropertyGIFDelayTime: delay
  ]
]

CGImageDestinationSetProperties(destination, gifProperties)

for frame in frames {
  guard
    let source = CGImageSourceCreateWithURL(frame as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    fputs("Unable to read frame \(frame.path)\n", stderr)
    exit(1)
  }
  CGImageDestinationAddImage(destination, image, frameProperties)
}

guard CGImageDestinationFinalize(destination) else {
  fputs("Unable to finalize GIF\n", stderr)
  exit(1)
}

print("wrote \(outURL.path) from \(frames.count) frames")
