fn main() {
    let metadata = std::process::Command::new("node")
        .args(["../scripts/build-metadata.mjs", "--rust"])
        .output().expect("Node 24+ is required to generate desktop identity");
    assert!(metadata.status.success(), "desktop metadata: {}", String::from_utf8_lossy(&metadata.stderr));
    std::fs::write(std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("product_identity.rs"), metadata.stdout)
        .expect("write desktop identity");
    for path in ["../scripts/build-metadata.mjs", "../../cezar/scripts/product-identity.mjs", "../../cezar/src/home/identity.ts", "../../cezar/src/home/switch.ts"] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    // Listing a command here generates its `allow-<command>` permission for capabilities/.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["retry_start", "connect_remote", "list_connections", "forget_connection"])),
    )
    .expect("failed to run tauri-build");
}
