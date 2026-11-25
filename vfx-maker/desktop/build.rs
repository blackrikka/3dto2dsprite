// Windows 대상일 때만 exe 에 아이콘/버전 리소스를 넣는다 (Linux 에서 크로스 컴파일 시에는 mingw 의 windres 사용).
fn main() {
    println!("cargo:rerun-if-changed=icon/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icon/icon.ico");
        res.set("ProductName", "VFX Maker");
        res.set("FileDescription", "VFX Maker");
        res.set("CompanyName", "");
        res.compile().expect("Windows 리소스(아이콘)를 컴파일하지 못했습니다");
    }
}
