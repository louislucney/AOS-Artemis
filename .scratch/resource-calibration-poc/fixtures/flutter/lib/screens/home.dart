import 'package:flutter/material.dart';

import '../theme/tokens.dart';

class Home extends StatelessWidget {
  const Home({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Image.asset('assets/images/avatar.png', width: 72, height: 72, fit: BoxFit.cover),
        Image.asset('assets/images/hero.png', width: 343, height: 160, fit: BoxFit.contain),
        Image.asset('assets/images/banner.png', width: 343, height: 120, fit: BoxFit.cover),
        Text('到店自取', style: AosTypography.pickup, maxLines: 1),
        Text('行動預點', style: AosTypography.title, maxLines: 1),
        Text('選擇門市後開始點餐', style: AosTypography.body, maxLines: 2),
      ],
    );
  }
}
