import { Image, Text, View } from "react-native";

import { typography } from "../theme/tokens";

export function Home() {
  return (
    <View>
      <Image source={require("../../assets/avatar.png")} style={styles.avatar} resizeMode="cover" />
      <Image source={require("../../assets/hero.png")} style={styles.hero} resizeMode="contain" />
      <Image source={require("../../assets/banner.png")} style={styles.banner} resizeMode="cover" />
      <Text style={typography.pickup} numberOfLines={1}>到店自取</Text>
      <Text style={typography.title} numberOfLines={1}>行動預點</Text>
      <Text style={typography.body} numberOfLines={2}>選擇門市後開始點餐</Text>
    </View>
  );
}

const styles = {
  avatar: { width: 72, height: 72 },
  hero: { width: 343, height: 160 },
  banner: { width: 343, height: 120 }
};
