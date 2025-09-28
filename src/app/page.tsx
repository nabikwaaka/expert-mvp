import "./globals.css";
import dynamic from "next/dynamic";

// Отключаем SSR для нашего хэш-роутера, чтобы всё работало как в прототипе
const MvpApp = dynamic(() => import("./_components/MvpApp"), { ssr: false });

export default function Page() {
  return <MvpApp />;
}
